import throttledQueue from "throttled-queue";
import type { EmuchievementsState } from "../hooks/achievementsContext";
import type { AllAchievements, GlobalAchievements } from "../SteamTypes";
import { format, getTranslateFunc } from "../useTranslations";
import Logger from "../logger";
import { getAppDetails } from "../steam-utils";
import { runInAction } from "mobx";

// const romRegex = "(\\/([a-zA-Z\\d-:_.\\s])+)+(?!\\.AppImage)(\\.zip|\\.7z|\\.iso|\\.bin|\\.chd|\\.cue|\\.img|\\.a26|\\.lnx|\\.ngp|\\.ngc|\\.3dsx|\\.3ds|\\.app|\\.axf|\\.cci|\\.cxi|\\.elf|\\.n64|\\.ndd|\\.u1|\\.v64|\\.z64|\\.nds|\\.dmg|\\.gbc|\\.gba|\\.gb|\\.ciso|\\.dol|\\.gcm|\\.gcz|\\.nkit\\.iso|\\.rvz|\\.wad|\\.wia|\\.wbfs|\\.nes|\\.fds|\\.unif|\\.unf|\\.json|\\.kp|\\.nca|\\.nro|\\.nso|\\.nsp|\\.xci|\\.rpx|\\.wud|\\.wux|\\.wua|\\.32x|\\.cdi|\\.gdi|\\.m3u|\\.gg|\\.gen|\\.md|\\.smd|\\.sms|\\.ecm\\|.mds|\\.pbp|\\.dump|\\.gz|\\.mdf|\\.mrg|\\.prx|\\.bs|\\.fig|\\.sfc|\\.smc|\\.swx|\\.pc2|\\.wsc|\\.ws)";
export const romRegex =
	'(\\/([^/"])+)+(?!\\.AppImage)(\\.zip|\\.7z|\\.iso|\\.bin|\\.chd|\\.cue|\\.img|\\.a26|\\.lnx|\\.ngp|\\.ngc|\\.elf|\\.n64|\\.ndd|\\.u1|\\.v64|\\.z64|\\.nds|\\.dmg|\\.gbc|\\.gba|\\.gb|\\.ciso|\\.cso|\\.rom|\\.nes|\\.fds|\\.unif|\\.unf|\\.32x|\\.cdi|\\.gdi|\\.m3u|\\.gg|\\.gen|\\.smd|\\.sms|\\.ecm|\\.mds|\\.pbp|\\.dump|\\.gz|\\.mdf|\\.mrg|\\.prx|\\.bs|\\.fig|\\.sfc|\\.smc|\\.swx|\\.pc2|\\.wsc|\\.ws|\\.md|\\.gcm|\\.gcz|\\.rvz|\\.wad|\\.wia|\\.wbfs)';

export interface Manager
{
	state: EmuchievementsState;

	init(): Promise<void>;

	deinit(): Promise<void>;

	refresh(): Promise<void>;

	clearCache(): void;

	saveCache(): Promise<void>;

	isSupported(steamAppId: number): boolean;

	isReady(steamAppId: number): boolean;

	fetchAchievements(steamAppId: number): FetchedAchievements;

	fetchAchievementsProgress(steamAppId: number): AchievementsProgress | undefined;

	clearRuntimeCacheForAppId(steamAppId: number): void;

	isEnabled(): boolean;
}

export enum StoreCategory
{
	MultiPlayer = 1,
	SinglePlayer = 2,
	CoOp = 9,
	PartialController = 18,
	MMO = 20,
	Achievements = 22,
	SteamCloud = 23,
	SplitScreen = 24,
	CrossPlatformMultiPlayer = 27,
	FullController = 28,
	TradingCards = 29,
	Workshop = 30,
	VRSupport = 31,
	OnlineMultiPlayer = 36,
	LocalMultiPlayer = 37,
	OnlineCoOp = 38,
	LocalCoOp = 392,
	RemotePlayTogether = 44,
	HighQualitySoundtrackAudio = 50
}

export interface FetchedAchievements
{
	user: AllAchievements;
	global: GlobalAchievements;
}
export const loadingFetchedAchievements: FetchedAchievements = {
	user: { loading: true },
	global: { loading: true }
};

export interface AchievementsProgress
{
	achieved: number;
	total: number;
	percentage: number;
}

export abstract class BaseManager<
	TCache extends {
		ids: Record<number, any | null>,
		custom_ids_overrides: Record<number, any>
	},
	TStore> implements Manager{

	protected t = getTranslateFunc();


	private _state: EmuchievementsState;

	get state(): EmuchievementsState
	{
		return this._state;
	}

	set state(value: EmuchievementsState)
	{
		this._state = value;
	}

	get globalLoading(): boolean
	{
		return this.state.loadingData.globalLoading;
	}

	set globalLoading(value: boolean)
	{
		this.state.loadingData.globalLoading = value;
	}

	get errored(): boolean
	{
		return this.state.loadingData.errored;
	}

	set errored(value: boolean)
	{
		this.state.loadingData.errored = value;
	}

	get processed(): number
	{
		return this.state.loadingData.processed;
	}

	set processed(value: number)
	{
		this.state.loadingData.processed = value;
	}

	get total(): number
	{
		return this.state.loadingData.total;
	}

	set total(value: number)
	{
		this.state.loadingData.total = value;
	}

	get game(): string
	{
		return this.state.loadingData.game;
	}

	set game(value: string)
	{
		this.state.loadingData.game = value;
	}

	get description(): string
	{
		return this.state.loadingData.description;
	}

	set description(value: string)
	{
		this.state.loadingData.description = value;
	}

	get managerName(): string
	{
		return this.state.loadingData.managerName;
	}

	set managerName(value: string)
	{
		this.state.loadingData.managerName = value;
	}

	get fetching(): boolean
	{
		return this.state.loadingData.fetching;
	}

	set fetching(value: boolean)
	{
		this.state.loadingData.fetching = value;
	}


	private cache: TCache = {
		ids: {},
		custom_ids_overrides: {},
	} as any;

	protected get ids()
	{
		return this.cache.ids;
	}

	protected set ids(value: TCache['ids'])
	{
		this.cache.ids = value;
	}

	protected get customIdsOverrides() {
		return this.cache.custom_ids_overrides;
	}

	protected set customIdsOverrides(value: TCache['custom_ids_overrides']) {
		this.cache.custom_ids_overrides = value;
	}


	protected userAchievements: Record<number, AllAchievements> = { 0: { loading: false } };
	protected globalAchievements: Record<number, GlobalAchievements> = { 0: { loading: false } };
	protected loading: Record<number, boolean> = { 0: false };
	protected store: Record<number, TStore> = {};

	protected readonly throttle = throttledQueue(4, 1000, true);

	protected readonly logger: Logger = new Logger(this.getName() + "Manager");

	constructor(state: EmuchievementsState)
	{
		this._state = state;
	}

	public fetchAchievementsProgress(app_id: number): AchievementsProgress | undefined
	{
		const achievements = this.fetchAchievements(app_id);
		// If there are achievements, render them in a progress bar.
		if (!!achievements.user.data)
		{
			const achieved = Object.keys(achievements.user.data.achieved).length;
			const total =
				Object.keys(achievements.user.data.achieved).length +
				Object.keys(achievements.user.data.unachieved).length +
				Object.keys(achievements.user.data.hidden).length;
			return {
				achieved,
				total,
				percentage: (achieved / total) * 100
			};
		}
		return;
	}

	protected abstract getName(): string;
	protected abstract getCacheKey(): keyof EmuchievementsState['settings'];
	
	public abstract refresh(): Promise<void>;

	public abstract isSupported(steamAppId: number): boolean;
	protected abstract getStoreForGame(steamAppId: number): Promise<TStore | undefined>;
	protected abstract processStore(store: TStore): FetchedAchievements;

	public isEnabled(): boolean {
		return true;
	}

	protected clearRuntimeCache()
	{
		this.userAchievements = { 0: { loading: false } };
		this.globalAchievements = { 0: { loading: false } };
		this.loading = { 0: false };
		this.store = {};
	}

	public clearRuntimeCacheForAppId(steamAppId: number)
	{
		delete this.store[steamAppId];
		delete this.userAchievements[steamAppId];
		delete this.globalAchievements[steamAppId];
		delete this.loading[steamAppId];
	}

	public clearCache()
	{
		this.clearRuntimeCache();

		this.ids = {};
		this.customIdsOverrides = {};
	}

	public async saveCache()
	{
		this.state.settings[this.getCacheKey()] = this.cache as any;
	}

	public async loadCache()
	{
		await this.state.settings.readSettings();
		this.cache = this.state.settings[this.getCacheKey()] as any;
		await this.saveCache();
	}

	public fetchAchievements(steamAppId: number)
	{
		const loading = this.loading[steamAppId] ?? this.loading[0];
		const user = this.userAchievements[steamAppId] ?? this.userAchievements[0];
		const global = this.globalAchievements[steamAppId] ?? this.globalAchievements[0];

		if (loading)
		{
			return loadingFetchedAchievements;
		}
		if (!user?.data)
		{
			this.loading[steamAppId] = true;
			this.throttle(async () =>
			{
				const result = this.store[steamAppId] ?
					this.processStore(this.store[steamAppId]) :
					await this.getStoreForGame(steamAppId)
						.then(store => {
							if (store)
								return this.processStore(store);
							else
								return loadingFetchedAchievements;
						});

				this.userAchievements[steamAppId] = result.user;
				this.globalAchievements[steamAppId] = result.global;
				this.loading[steamAppId] = false;
				try { appDetailsStore.GetAchievements(steamAppId); } catch (_) {}
				this.state.notifyUpdate();
			});

			return loadingFetchedAchievements;
		} else
		{
			return {
				user,
				global
			};
		}
	}

	protected async fetchAchievementsAsync(steamAppId: number): Promise<FetchedAchievements | undefined>
	{
		const loading = this.loading[steamAppId] ?? this.loading[0];
		const user = this.userAchievements[steamAppId] ?? this.userAchievements[0];
		const global = this.globalAchievements[steamAppId] ?? this.globalAchievements[0];

		if (loading)
		{
			return loadingFetchedAchievements;
		}
		if (!user?.data)
		{
			this.loading[steamAppId] = true;
			return await this.throttle(async () =>
			{
				const result = this.store[steamAppId] ?
					this.processStore(this.store[steamAppId]) :
					await this.getStoreForGame(steamAppId)
						.then(trophies => {
							if (trophies)
								return this.processStore(trophies);
							else
								return loadingFetchedAchievements;
						});

				this.userAchievements[steamAppId] = result.user;
				this.globalAchievements[steamAppId] = result.global;
				this.loading[steamAppId] = false;

				return result;

			});
		} else
		{
			return {
				user,
				global
			};
		}
	}
	
	protected async refreshAchievementsForApp(steamAppId: number): Promise<void>
	{
		try
		{
			await this.throttle(async () =>
			{
				const overview = appStore.GetAppOverviewByAppID(steamAppId);

				const details = await getAppDetails(steamAppId);
				const data = await this.countAchievementsForApp(steamAppId);
				this.game = overview.display_name;
				if (details && data.numberOfAchievements !== 0)
					this.description = format(this.t("foundAchievements"), data.numberOfAchievements, data.id);
				else
					this.description = this.t("noAchievements");
				this.processed++;
				this.logger.debug(
					`loading achievements: ${this.state.loadingData.percentage}% done`,
					steamAppId,
					details,
					overview
				);
			});
		} catch (e)
		{
			this.logger.error(e, `Error refreshing achievements for app ${steamAppId}`);
			throw e;
		}
	}

	protected async countAchievementsForApp(steamAppId: number): Promise<{ numberOfAchievements: number; id?: string; }>
	{
		try
		{
			let numberOfAchievements = 0;
			let achievements = await this.fetchAchievementsAsync(steamAppId);
			if (achievements)
			{
				this.logger.debug(steamAppId, this.userAchievements[steamAppId]);

				if (!!this.userAchievements[steamAppId])
				{
					const ret = this.userAchievements[steamAppId]?.data;
					if (!!ret)
					{
						if (!appAchievementProgressCache.m_achievementProgress)
						{
							await appAchievementProgressCache.RequestCacheUpdate();
						}
						numberOfAchievements = Object.keys(ret.achieved).length +
							Object.keys(ret.unachieved).length +
							Object.keys(ret.hidden).length;
						const nAchieved = Object.keys(ret.achieved).length;
						runInAction(() =>
						{
							appAchievementProgressCache.m_achievementProgress.mapCache.set(steamAppId, {
								all_unlocked: nAchieved === numberOfAchievements,
								appid: steamAppId,
								cache_time: new Date().getTime(),
								percentage: (nAchieved / numberOfAchievements) * 100,
								total: numberOfAchievements,
								unlocked: nAchieved,
							});
							appAchievementProgressCache.SaveCacheFile();
							this.logger.debug(
								`achievementsCache: `,
								{
									all_unlocked: nAchieved === numberOfAchievements,
									appid: steamAppId,
									cache_time: new Date().getTime(),
									percentage: (nAchieved / numberOfAchievements) * 100,
									total: numberOfAchievements,
									unlocked: nAchieved,
								},
								appAchievementProgressCache.m_achievementProgress.mapCache.get(steamAppId)
							);
						});
					}
				}
			}
			return {
				numberOfAchievements,
				id: this.ids[steamAppId] ?? undefined,
			};
		} catch (e)
		{
			this.logger.error(e, `Error counting achievements for app ${steamAppId}`);
			throw e;
		}
	}

	public async init(): Promise<void>
	{
		await this.loadCache();
		if(this.isEnabled())
			await this.refresh();
	}

	public deinit(): Promise<void> {
		return Promise.resolve();
	}
	
	public isReady(steamAppId: number): boolean
	{
		return !!this.userAchievements[steamAppId] && !this.userAchievements[steamAppId].loading
	}

	protected grayScaleIcon(icon: string): Promise<string>{
		return new Promise<string>((resolve) => {
			let img = new Image();
			img.crossOrigin = 'Anonymous';
			img.onload = () => {
				// 1. Create off-screen canvas and context
				const canvas = document.createElement('canvas');
				const ctx = canvas.getContext('2d')!;
				
				canvas.width = img.width;
				canvas.height = img.height;

				// 2. Draw image onto canvas
				ctx.drawImage(img, 0, 0);

				// 3. Extract pixel data (RGBA array)
				const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
				const data = imageData.data;

				// 4. Loop through pixels (step by 4: R, G, B, A)
				for (let i = 0; i < data.length; i += 4) {
					// Luminance formula for human perception weighting
					const avg = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
					
					data[i]     = avg; // Red
					data[i + 1] = avg; // Green
					data[i + 2] = avg; // Blue
				}

				// 5. Put grayscale pixel data back and return new base64 string
				ctx.putImageData(imageData, 0, 0);
				resolve(canvas.toDataURL('image/png'));
			};

			img.src = icon;
		});
	}
}