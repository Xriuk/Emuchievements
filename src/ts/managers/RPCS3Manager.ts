import { call, toaster } from "@decky/api";
import Logger from "../logger";
import
{
	getAllNonSteamAppIds,
	getAppDetails,
	waitForOnline,
} from "../steam-utils";
import { AllAchievements, GlobalAchievements, type SteamAppAchievement } from "../SteamTypes";
import { Promise } from "bluebird";
import { runInAction } from "mobx";
import { format } from "../useTranslations";
import { RPCS3_USER_PATH_DEFAULT, type RPCS3CacheData, type RPCS3CustomIdsOverrides } from "../settings";
import { BaseManager, loadingFetchedAchievements, type FetchedAchievements } from "./Manager";
import { romRegex } from "./RetroAchievementsManager";

const rpcs3IdRegex = '\\/dev_hdd0\\/game\\/([A-Z0-9]+)\\/';
const rpcs3RomPathRegex = '(\\/home\\/deck\\/.+\\/PS3_GAME)\\/USRDIR\\/EBOOT\\.BIN';

type RPCS3TrophyStatus = {
	unlocked?: boolean;
	unlock_time_utc?: number; // UNIX timestamp
};

type RPCS3GameTrophies = {
	game?: {
		name?: string;
		detail?: string;
		trophy_id?: string;
	},
	trophies: {
		id: string;
		hidden?: boolean;
		type: 'P' | 'G' | 'S' | 'B';
		name: string;
		detail?: string;
		icon: string;
		locked_icon: string;
	}[],
	user?: string,
	progress?: Record<string, RPCS3TrophyStatus>
};

/**
 * Retrieves trophies from RPCS3 for installed games and folders, even not yet installed trophies
 * (for games which have not been run yet)
 */
export class RPCS3Manager extends BaseManager
{
	private cache: RPCS3CacheData = {
		ids: {},
		custom_ids_overrides: {},
	};

	private get ids()
	{
		return this.cache.ids;
	}

	private set ids(value: Record<number, string | null>)
	{
		this.cache.ids = value;
	}

	private get customIdsOverrides() {
		return this.cache.custom_ids_overrides;
	}

	private set customIdsOverrides(value: Record<number, RPCS3CustomIdsOverrides>) {
		this.cache.custom_ids_overrides = value;
	}

	private trophies: Record<number, RPCS3GameTrophies> = {};

	private userAchievements: Record<number, AllAchievements> = { 0: { loading: false } };

	private globalAchievements: Record<number, GlobalAchievements> = { 0: { loading: false } };

	private loading: Record<number, boolean> = { 0: false };

	private logger: Logger = new Logger("RPCS3Manager");

	private clearRuntimeCache()
	{
		this.userAchievements = { 0: { loading: false } };
		this.globalAchievements = { 0: { loading: false } };
		this.loading = { 0: false };
		this.trophies = {};
	}

	public clearRuntimeCacheForAppId(appId: number)
	{
		delete this.trophies[appId];
		delete this.userAchievements[appId];
		delete this.globalAchievements[appId];
		delete this.loading[appId];
	}

	public clearCache()
	{
		this.clearRuntimeCache();

		this.ids = {};
		this.customIdsOverrides = {};
	}

	public clearCacheForAppId(appId: number)
	{
		this.clearRuntimeCacheForAppId(appId);
	}

	public async saveCache()
	{
		this.state.settings.rpcs3Cache = this.cache;
	}

	public async loadCache()
	{
		await this.state.settings.readSettings();
		this.cache = this.state.settings.rpcs3Cache;
		await this.saveCache();
	}

	private async getAchievementsForGame(app_id: number): Promise<RPCS3GameTrophies | undefined>
	{
		if (this.ids[app_id] === null && this.customIdsOverrides[app_id]?.rpcs3_trophy_id === null)
			return undefined;

		const user = (this.state.settings.rpcs3.user_path
			?? RPCS3_USER_PATH_DEFAULT);
		if(!user)
			return undefined;

		this.logger.debug(`${app_id} user: `, user);

		await waitForOnline();
		const shortcut = await getAppDetails(app_id);
		this.logger.debug(`${app_id} shortcut: `, shortcut);

		let romFolder: string | undefined = undefined;
		let gameId: string | null = null;
		if (shortcut)
		{
			const launchCommand = `${shortcut.strShortcutExe} ${shortcut.strShortcutLaunchOptions}`;
			this.logger.debug(`${app_id} launchCommand: `, launchCommand);
			const rom = launchCommand.match(new RegExp(romRegex, "i"))?.[0];
			this.logger.debug(`${app_id} rom: `, rom);
			const isRpcs3 = launchCommand.indexOf('/rpcs3.sh') !== -1;
			this.logger.debug(`${app_id} isRpcs3: `, isRpcs3);
			if (rom && isRpcs3)
			{
				if (!this.customIdsOverrides) {
					this.customIdsOverrides = {}

					await this.saveCache();
				}

				if (!this.customIdsOverrides[app_id]) {
					this.ids[app_id] = null;
					this.customIdsOverrides[app_id] = {
						name: shortcut.strDisplayName,
						rpcs3_trophy_id: null,
						rpcs3_game_id: undefined
					}

					await this.saveCache();
				}

				if (this.customIdsOverrides[app_id] && this.customIdsOverrides[app_id]?.rpcs3_trophy_id) {
					this.ids[app_id] = this.customIdsOverrides[app_id].rpcs3_trophy_id;
				} else {
					// If the game is installed it will have its id in the path
					// Then we retrieve the trophy dir, either from the game id path or from the rom folder itself
					gameId = rom.match(new RegExp(rpcs3IdRegex))?.[1] ?? null;
					let trophyId: string | null;
					if(gameId)
						trophyId = await call<[string], string>("rpcs3_get_trophy_dir_path", this.getHddPath() + "game/" + gameId) ?? null;
					else{
						romFolder = rom.match(new RegExp(rpcs3RomPathRegex))?.[1];
						if(romFolder)
							trophyId = await call<[string], string>("rpcs3_get_trophy_dir_path", romFolder) ?? null;
						else
							trophyId = null;
					}

					this.logger.debug(`${app_id} trophy id: `, trophyId);
					this.logger.debug(`${app_id} game id: `, gameId);

					this.ids[app_id] = trophyId;
					if (trophyId) {
						if (!this.customIdsOverrides[app_id]) {
							this.customIdsOverrides[app_id] = {
								name: shortcut.strDisplayName,
								rpcs3_trophy_id: null
							}
						}

						this.customIdsOverrides[app_id].rpcs3_trophy_id = trophyId;
						this.customIdsOverrides[app_id].rpcs3_game_id = gameId;
					}
					await this.saveCache();
				}
			} else
			{
				this.ids[app_id] = null;
				await this.saveCache();
				return undefined;
			}
		} else
		{
			this.ids[app_id] = null;
			await this.saveCache();
			return undefined;
		}

		let trophy_id: string | undefined | null = this.ids[app_id];
		if (typeof trophy_id === "string" && trophy_id !== "")
		{
			// Try retrieving the trophies from the user directory first
			let result = await call<[string, string], string>("rpcs3_get_all_trophies_user", user, trophy_id) ?? null;
			let trophies = JSON.parse(result ?? '{}') as RPCS3GameTrophies;
			
			let locale = this.state.settings.rpcs3.locale ?? 'en';

			// If we found nothing we search the game folder
			let gameTrophies = false; // True if retrieved from game folder (0 achieved)
			if(!trophies.trophies.length){
				if(romFolder)
					result = await call<[string, string], string>("rpcs3_get_all_trophies_game", romFolder + "/TROPDIR/" + trophy_id + "/TROPHY.TRP", locale.toLowerCase()) ?? null;
				else if(gameId)
					result = await call<[string, string], string>("rpcs3_get_all_trophies_game", this.getHddPath() + "game/" + gameId + "/TROPDIR/" + trophy_id + "/TROPHY.TRP", locale.toLowerCase()) ?? null;
				else
					result = '';

				if(result){
					trophies = JSON.parse(result ?? '{}') as RPCS3GameTrophies;
					gameTrophies = true;
				}
			}

			this.logger.debug(`${app_id} trophies: `, trophies);

			if(!trophies.trophies.length)
				return undefined;

			for(let trophy of trophies.trophies){
				trophy.icon = await call<[string, string, string], string>("rpcs3_get_trophy_icon_user", user, trophy_id, trophy.id) ?? '';
				
				if(!trophy.icon){
					if(romFolder)
						trophy.icon = await call<[string, string], string>("rpcs3_get_trophy_icon_game", romFolder + "/TROPDIR/" + trophy_id + "/TROPHY.TRP", trophy.id) ?? '';
					else if(gameId)
						trophy.icon = await call<[string, string], string>("rpcs3_get_trophy_icon_game", this.getHddPath() + "game/" + gameId + "/TROPDIR/" + trophy_id + "/TROPHY.TRP", trophy.id) ?? '';
				}
				
				// Create a locked grayscale version
				if(trophy.icon){
					trophy.locked_icon = await new Promise<string>((resolve) => {
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

						img.src = trophy.icon;
					});
				}
				else
					trophy.locked_icon = '';
			}

			// Retrieve progress for non-game trophies (actually played)
			if(!gameTrophies){
				result = await call<[string, string], string>("rpcs3_get_all_trophies_status", user, trophy_id) ?? null;
				trophies.progress = JSON.parse(result ?? '[]') as Record<string, RPCS3TrophyStatus>;
				this.logger.debug(`${app_id} progress: `, trophies.progress);
			}

			trophies.game ??= {};
			trophies.game.trophy_id = trophy_id;
			trophies.user = user;

			this.trophies[app_id] = trophies;
			return trophies;
		}
		
		return undefined;
	}

	private processTrophies(trophies: RPCS3GameTrophies): FetchedAchievements{
		const defaultAchievements: AllAchievements = {
			data: { achieved: {}, hidden: {}, unachieved: {} },
			loading: false,
		};

		const defaultGlobalAchievements: GlobalAchievements = {
			data: {},
			loading: false,
		};

		for(let trophy of trophies.trophies){
			this.logger.debug('Trophy: ', trophy);
			let achieved = trophies.progress?.[trophy.id]?.unlocked === true;

			const steam: SteamAppAchievement = {
				bAchieved: achieved,
				bHidden: trophy.hidden === true,
				flAchieved: 0, // Percentage of players who achieved (0-100) // DEV: find how to add
				flCurrentProgress: achieved ? 1 : 0, // Progress percentage of the player achievement (flMinProgress-flMaxProgress)
				flMaxProgress: 1,
				flMinProgress: 0,
				rtUnlocked: (achieved && trophies.progress?.[trophy.id]?.unlock_time_utc) ?
					trophies.progress[trophy.id].unlock_time_utc! :
					0, // Unlocked date timestamp
				strDescription: trophy.detail ?? '',
				strID: trophy.id,
				strImage: achieved ? trophy.icon : trophy.locked_icon,
				strName: trophy.name
			};

			if(this.state.settings.rpcs3.show_cat_prefixes !== false){
				switch(trophy.type){
				case 'B':
					steam.strName = "🟧 " + steam.strName;
					break;
				case 'S':
					steam.strName = "⬜ " + steam.strName;
					break;
				case 'G':
					steam.strName = "🟨 " + steam.strName;
					break;
				case 'P':
					steam.strName = "💎 " + steam.strName;
					break;
				}
			}
			if(false /*this.state.settings.general.show_achieved_state_prefixes*/){
				if(steam.bAchieved)
					steam.strName = "[ACHIEVED] " + steam.strName;
				else
					steam.strName = "[NOT ACHIEVED] " + steam.strName;
			}

			if(steam.bAchieved)
				defaultAchievements.data!.achieved[steam.strID] = steam;
			else if(trophy.hidden)
				defaultAchievements.data!.hidden[steam.strID] = steam;
			else
				defaultAchievements.data!.unachieved[steam.strID] = steam;

			defaultGlobalAchievements.data![steam.strID] = steam.flAchieved;
		}

		return { user: defaultAchievements, global: defaultGlobalAchievements };
	}

	public fetchAchievements(app_id: number): FetchedAchievements
	{
		const loading = this.loading[app_id] ?? this.loading[0];
		const user = this.userAchievements[app_id] ?? this.userAchievements[0];
		const global = this.globalAchievements[app_id] ?? this.globalAchievements[0];

		if (loading)
		{
			return loadingFetchedAchievements;
		}
		if (!user?.data)
		{
			this.loading[app_id] = true;
			this.throttle(async () =>
			{
				const result = this.trophies[app_id] ?
					this.processTrophies(this.trophies[app_id]) :
					await this.getAchievementsForGame(app_id)
						.then(trophies => {
							if (trophies)
								return this.processTrophies(trophies);
							else
								return loadingFetchedAchievements;
						});

				this.userAchievements[app_id] = result.user;
				this.globalAchievements[app_id] = result.global;
				this.loading[app_id] = false;
				try { appDetailsStore.GetAchievements(app_id); } catch (_) {}
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

	private async fetchAchievementsAsync(app_id: number): Promise<FetchedAchievements | undefined>
	{
		const loading = this.loading[app_id] ?? this.loading[0];
		const user = this.userAchievements[app_id] ?? this.userAchievements[0];
		const global = this.globalAchievements[app_id] ?? this.globalAchievements[0];

		if (loading)
		{
			return loadingFetchedAchievements;
		}
		if (!user?.data)
		{
			this.loading[app_id] = true;
			return await this.throttle(async () =>
			{
				const result = this.trophies[app_id] ?
					this.processTrophies(this.trophies[app_id]) :
					await this.getAchievementsForGame(app_id)
						.then(trophies => {
							if (trophies)
								return this.processTrophies(trophies);
							else
								return loadingFetchedAchievements;
						});

				this.userAchievements[app_id] = result.user;
				this.globalAchievements[app_id] = result.global;
				this.loading[app_id] = false;

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

	private async refreshAchievementsForApp(app_id: number): Promise<void>
	{
		try
		{
			await this.throttle(async () =>
			{
				const overview = appStore.GetAppOverviewByAppID(app_id);

				const details = await getAppDetails(app_id);
				const data = await this.countAchievementsForApp(app_id);
				if (details && data.numberOfAchievements !== 0)
				{
					this.game = overview.display_name;
					this.description = format(this.t("rpcs3FoundTrophies"), data.numberOfAchievements, data.id);
					this.processed++;
				} else
				{
					this.game = overview.display_name;
					this.description = this.t("rpcs3NoTrophies");
					this.processed++;
				}
				this.logger.debug(
					`loading trophies: ${this.state.loadingData.percentage}% done`,
					app_id,
					details,
					overview
				);
			});
		} catch (e)
		{
			this.logger.error(e, `Error refreshing trophies for app ${app_id}`);
			throw e;
		}
	}

	private async countAchievementsForApp(app_id: number): Promise<{ numberOfAchievements: number; id?: string; }>
	{
		try
		{
			let numberOfAchievements = 0;
			let achievements = await this.fetchAchievementsAsync(app_id);
			if (achievements)
			{
				this.logger.debug(app_id, this.userAchievements);

				if (!!this.userAchievements[app_id])
				{
					const ret = this.userAchievements[app_id]?.data;
					if (!!ret)
					{
						if (!appAchievementProgressCache.m_achievementProgress)
						{
							await appAchievementProgressCache.RequestCacheUpdate();
						}
						numberOfAchievements =
							Object.keys(ret.achieved).length + Object.keys(ret.unachieved).length;
						const nAchieved = Object.keys(ret.achieved).length;
						const nTotal = Object.keys(ret.achieved).length + Object.keys(ret.unachieved).length;
						runInAction(() =>
						{
							appAchievementProgressCache.m_achievementProgress.mapCache.set(app_id, {
								all_unlocked: nAchieved === nTotal,
								appid: app_id,
								cache_time: new Date().getTime(),
								percentage: (nAchieved / nTotal) * 100,
								total: nTotal,
								unlocked: nAchieved,
							});
							appAchievementProgressCache.SaveCacheFile();
							this.logger.debug(
								`achievementsCache: `,
								{
									all_unlocked: nAchieved === nTotal,
									appid: app_id,
									cache_time: new Date().getTime(),
									percentage: (nAchieved / nTotal) * 100,
									total: nTotal,
									unlocked: nAchieved,
								},
								appAchievementProgressCache.m_achievementProgress.mapCache.get(app_id)
							);
						});
					}
				}
			}
			return {
				numberOfAchievements,
				id: this.ids[app_id] ?? undefined,
			};
		} catch (e)
		{
			this.logger.error(e, `Error counting achievements for app ${app_id}`);
			throw e;
		}
	}

	private getHddPath(){
		return (this.state.settings.rpcs3.user_path
				?? RPCS3_USER_PATH_DEFAULT)
			.split('/dev_hdd0/home/')[0] + '/dev_hdd0/';
	}

	public async refresh(): Promise<void>
	{
		try
		{
			this.errored = false;
			let user = (this.state.settings.rpcs3.user_path
				?? RPCS3_USER_PATH_DEFAULT);
			if (user && await call<[string], boolean>("rpcs3_check_user_path", user))
			{
				if (!this.globalLoading)
				{
					this.globalLoading = true;
					this.game = this.t("fetching");
					this.fetching = true;
					this.clearRuntimeCache();

					this.logger.log("Fetching non-Steam app IDs");
					const allNonSteamAppIds = await getAllNonSteamAppIds();
					this.logger.log(`Found ${allNonSteamAppIds.length} non-Steam apps`);
					const nonSteamAppIdsWithRPCS3Id = allNonSteamAppIds.filter((appId) => (this.ids[appId] !== null || this.customIdsOverrides[appId]?.rpcs3_trophy_id !== null));
					this.logger.log(`${nonSteamAppIdsWithRPCS3Id.length} apps have or might have PS3 IDs`);

					// NOTE: Checks for games what does not exists in user library and removes them from
					//       `cache` configuration
					const gameIdsToBeRemoved = Object.keys(this.customIdsOverrides)
						.filter((appId) => !allNonSteamAppIds.includes(Number.parseInt(appId, 10)));

					if (gameIdsToBeRemoved.length > 0) {
						this.logger.log(`Removing ${gameIdsToBeRemoved.length} stale cache entries: ${gameIdsToBeRemoved.join(", ")}`);
					}
					for (const gameIdToBeRemoved of gameIdsToBeRemoved) {
						const gameIdToBeRemovedAsNumber = Number.parseInt(gameIdToBeRemoved, 10);

						delete this.ids[gameIdToBeRemovedAsNumber]
						delete this.customIdsOverrides[gameIdToBeRemovedAsNumber]
					}

					this.managerName = "RPCS3";
					this.logger.log(`Refreshing trophies for ${nonSteamAppIdsWithRPCS3Id.length} apps`);
					this.fetching = false;
					this.total = nonSteamAppIdsWithRPCS3Id.length;
					this.processed = 0;

					await Promise.map(nonSteamAppIdsWithRPCS3Id, async (app_id) => await this.refreshAchievementsForApp(app_id), {
						concurrency: 8
					});

					this.logger.log("Finished refreshing trophies");
					this.globalLoading = false;
					this.game = this.t("fetching");
					this.managerName = "";
					this.description = "";
					this.processed = 0;
					this.total = 0;
				}
			} else
			{
				toaster.toast({
					title: "[RPCS3]: " + this.t("title"),
					body: this.t("rpcs3NoUser"),
				});
			}
		} catch (e: any)
		{
			this.globalLoading = false;
			this.errored = true;
			this.description = `${e.constructor.name}: ${e.message}`;

			this.logger.error(e, `${e.constructor.name}: ${e.message}`);
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

	public isSupported(steamAppId: number): boolean {
		return (this.ids[steamAppId] != null || this.customIdsOverrides[steamAppId]?.rpcs3_trophy_id != null);
	}

	public isReady(steamAppId: number): boolean
	{
		return !!this.userAchievements[steamAppId] && !this.userAchievements[steamAppId].loading
	}

	override isEnabled(): boolean {
		return this.state.settings.rpcs3.enabled !== false;
	}
}