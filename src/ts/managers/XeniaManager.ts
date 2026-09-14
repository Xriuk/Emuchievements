import { call, toaster } from "@decky/api";
import type { XeniaCacheData } from "../settings";
import { getAllNonSteamAppIds, getAppDetails } from "../steam-utils";
import type { AllAchievements, GlobalAchievements, SteamAppAchievement } from "../SteamTypes";
import { BaseManager, romRegex } from "./Manager";
import { Promise } from "bluebird";

type XeniaAchievement = {
	id: number;
	name: string;
	description_achieved: string;
	description_unachieved: string;
	icon_id: number;
	gamerscore: number;
	flags?: {
		type?: 'Completion' | 'Leveling' | 'Unlock' | 'Event' | 'Tournament' | 'Checkpoint' | 'Other';
		secret: boolean;
		earned_online: boolean;
		earned: boolean;
		edited: boolean;
	};

	unlock_time?: number; // Only in status call

	icon: string;
	locked_icon: string;
};

type XeniaGameAchievements = {
	achievements: XeniaAchievement[];
};

type XeniaGameAchievementsStats = XeniaGameAchievements & {
	progress?: Record<number, XeniaAchievement>;
};

/**
 * Retrieves achievements from Xenia
 */
export class XeniaManager extends BaseManager<XeniaCacheData, XeniaGameAchievementsStats>{
	private _achievements: Record<number, XeniaGameAchievements | null> = {};
	
	protected getName(){
		return "Xenia";
	}

	protected getCacheKey(){
		return "xeniaCache" as const;
	}

	override clearCache(): void {
		super.clearCache();

		this._achievements = {};
	}

	protected async getStoreForGame(app_id: number): Promise<XeniaGameAchievementsStats | undefined>
	{
		if (this.ids[app_id] === null && this.customIdsOverrides[app_id]?.xenia_title_id === null)
			return undefined;

		const user = this.state.settings.xenia.user_path;
		if(!user)
			return undefined;

		this.logger.debug(`${app_id} user: `, user);

		const shortcut = await getAppDetails(app_id);
		this.logger.debug(`${app_id} shortcut: `, shortcut);

		let rom: string | undefined = undefined;
		let titleId: string | null = null;
		if (shortcut)
		{
			const launchCommand = `${shortcut.strShortcutExe} ${shortcut.strShortcutLaunchOptions}`;
			this.logger.debug(`${app_id} launchCommand: `, launchCommand);
			rom = launchCommand.match(new RegExp(romRegex, "i"))?.[0];
			this.logger.debug(`${app_id} rom: `, rom);
			const isXenia = launchCommand.indexOf('/xenia.sh') !== -1;
			this.logger.debug(`${app_id} isXenia: `, isXenia);
			if (rom && isXenia)
			{
				if (!this.customIdsOverrides) {
					this.customIdsOverrides = {}

					await this.saveCache();
				}

				if (!this.customIdsOverrides[app_id]) {
					this.ids[app_id] = null;
					this.customIdsOverrides[app_id] = {
						name: shortcut.strDisplayName,
						xenia_title_id: null,
						xenia_rom_path: null
					}

					await this.saveCache();
				}

				if (this.customIdsOverrides[app_id] && this.customIdsOverrides[app_id]?.xenia_title_id) {
					this.ids[app_id] = this.customIdsOverrides[app_id].xenia_title_id;
				} else {
					// Retrieve the game id from default.xex inside the rom
					// Retrieving it from recent games would not have been efficient as it would have required opening multiple files
					titleId = await call<[string], string>("xenia_get_titleid_game", rom) ?? null;

					this.logger.debug(`${app_id} game id: `, titleId);

					this.ids[app_id] = titleId;
					if (!this.customIdsOverrides[app_id]) {
						this.customIdsOverrides[app_id] = {
							name: shortcut.strDisplayName,
							xenia_title_id: null,
							xenia_rom_path: null
						}
					}

					this.customIdsOverrides[app_id].xenia_title_id = titleId;
					this.customIdsOverrides[app_id].xenia_rom_path = rom;
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

		let title_id: string | undefined | null = this.ids[app_id];
		if (typeof title_id === "string" && title_id !== "")
		{
			// Retrieve from cache first, since achievements data do not change
			let achievements: XeniaGameAchievementsStats;
			let userAchievements = true;
			let progressRetrieved = false;
			if(this._achievements[app_id] === null)
				return undefined;
			else if(this._achievements[app_id])
				achievements = { ...this._achievements[app_id] };
			else{
				achievements = { } as any;

				// Retrieve progress, and maybe achievements
				let result = await call<[string, string], string>("xenia_get_all_achievements_status", user, title_id) ?? null;
				achievements.progress = JSON.parse(result ?? '{}') as Record<number, XeniaAchievement>;
				progressRetrieved = true;

				// If we also have achievements (at least names) we populate them
				achievements.achievements = Object.values(achievements.progress)
				if(!achievements.achievements.every(a => a.name))
					achievements.achievements = [];

				// If we found nothing we search the game ROM
				if(!achievements.achievements.length && rom){
					let locale = this.state.settings.xenia.locale ?? 'en';	

					// Retrieve achievements info from the game rom
					result = await call<[string, string, string], string>("xenia_get_all_achievements_game", rom, title_id, locale.toLowerCase()) ?? null;
					if(result){
						achievements.achievements = (JSON.parse(result ?? '{}') as XeniaGameAchievements).achievements;
						userAchievements = false;
					}
				}

				// Retrieve trophies icons and create grayscale versions for locked
				for(let achievement of achievements.achievements){
					// Retrieve icon from user profile GPD first
					if(userAchievements)
						achievement.icon = await call<[string, string, number], string>("xenia_get_achievement_icon_user", user, title_id, achievement.icon_id) ?? '';
					
					// If not found retrieve from game ROM
					if(!achievement.icon && rom)
						achievement.icon = await call<[string, string, number], string>("xenia_get_achievement_icon_game", rom, title_id, achievement.icon_id) ?? '';
					
					// Create a locked grayscale version
					if(achievement.icon)
						achievement.locked_icon = await this.grayScaleIcon(achievement.icon);
					else
						achievement.locked_icon = '';
				}

				this.logger.debug(`${app_id} achievements: `, achievements);

				if(achievements.achievements.length){
					this._achievements[app_id] = { ...achievements };
					delete (this._achievements[app_id] as any).progress;
				}
				else
					this._achievements[app_id] = null;
			}

			if(!achievements.achievements.length)
				return undefined;

			// Retrieve progress if using cached data
			if(!progressRetrieved && userAchievements){
				let result = await call<[string, string], string>("xenia_get_all_achievements_status", user, title_id) ?? null;
				achievements.progress = JSON.parse(result ?? '{}') as Record<number, XeniaAchievement>;
				this.logger.debug(`${app_id} progress: `, achievements.progress);
			}
			else
				this.logger.debug(`${app_id} no progress yet`);

			this.store[app_id] = achievements;
			return achievements;
		}
		
		return undefined;
	}

	protected processStore(store: XeniaGameAchievementsStats){
		const defaultAchievements: AllAchievements = {
			data: { achieved: {}, hidden: {}, unachieved: {} },
			loading: false,
		};

		const defaultGlobalAchievements: GlobalAchievements = {
			data: {},
			loading: false,
		};

		for(let achievement of store.achievements){
			this.logger.debug('Achievement: ', achievement);
			let achieved = achievement.flags?.earned === true ||
				achievement.flags?.earned_online === true;

			// Default rarity to Gamerpoints, make an estimate
			// https://github.com/justin-delano/PlayniteAchievements/blob/24b1bcab770277a645ef93f52795823739e0ae0e/source/Providers/Xenia/XeniaScanner.cs#L159
			let achievedPerc = 0;
			if(achievement.gamerscore > 0){
				// Exponential decay model: P(GS) = 100 * e^(-0.023 * GS)
				achievedPerc = 100.0 * Math.exp(-0.023 * achievement.gamerscore);

				// Clamp output between 0.0% and 100.0%
				achievedPerc = Math.max(0.0, Math.min(100.0, achievedPerc));
			}

			let unlocked: number;
			if(achieved && store.progress?.[achievement.id]?.unlock_time){
				const fileTimeBigInt = BigInt(store.progress[achievement.id].unlock_time!);
	
				// 100-nanosecond intervals between Jan 1, 1601 and Jan 1, 1970
				const WINDOWS_TICK_OFFSET = 116444736000000000n;
				
				// Convert ticks to Unix epoch milliseconds
				unlocked = Number((fileTimeBigInt - WINDOWS_TICK_OFFSET) / 10000000n);
			}
			else
				unlocked = 0;

			const steam: SteamAppAchievement = {
				bAchieved: achieved,
				bHidden: achievement.flags?.secret === true,
				flAchieved: achievedPerc, // Percentage of players who achieved (0-100)
				flCurrentProgress: achieved ? 1 : 0, // Progress percentage of the player achievement (flMinProgress-flMaxProgress)
				flMaxProgress: 1,
				flMinProgress: 0,
				rtUnlocked: unlocked, // Unlocked date timestamp
				strDescription: (((achieved && this.state.settings.xenia.show_description_locked === undefined) || this.state.settings.xenia.show_description_locked === false) ?
					achievement.description_achieved :
					achievement.description_unachieved) ?? '',
				strID: achievement.id.toString(),
				strImage: achieved ? achievement.icon : achievement.locked_icon,
				strName: achievement.name
			};

			if(this.state.settings.xenia.show_gamerscore !== false && achievement.gamerscore > 0)
				steam.strDescription = `G ${achievement.gamerscore} - ${steam.strDescription}`;
			if(false /*this.state.settings.general.show_achieved_state_prefixes*/){
				if(steam.bAchieved)
					steam.strName = "[ACHIEVED] " + steam.strName;
				else
					steam.strName = "[NOT ACHIEVED] " + steam.strName;
			}

			if(steam.bAchieved)
				defaultAchievements.data!.achieved[steam.strID] = steam;
			else if(steam.bHidden)
				defaultAchievements.data!.hidden[steam.strID] = steam;
			else
				defaultAchievements.data!.unachieved[steam.strID] = steam;

			defaultGlobalAchievements.data![steam.strID] = steam.flAchieved;
		}

		return {
			user: defaultAchievements,
			global: defaultGlobalAchievements
		};
	}
	
	public async refresh(): Promise<void>
	{
		try
		{
			this.errored = false;
			let user = this.state.settings.xenia.user_path;
			if(!user || !(await call<[string], boolean>("xenia_check_user_path", user))){
				toaster.toast({
					title: `[${this.getName()}]: ${this.t("title")}`,
					body: this.t("noUser")
				});
			}
			else if(!(await call<[], boolean>("xenia_check_wine_path"))){
				toaster.toast({
					title: `[${this.getName()}]: ${this.t("title")}`,
					body: this.t("xeniaNoWine")
				});
			}
			else
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
					const nonSteamAppIdsWithXeniaId = allNonSteamAppIds.filter((appId) => (this.ids[appId] !== null || this.customIdsOverrides[appId]?.xenia_title_id !== null));
					this.logger.log(`${nonSteamAppIdsWithXeniaId.length} apps have or might have Xbox 360 IDs`);

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

					this.managerName = this.getName();
					this.logger.log(`Refreshing achievements for ${nonSteamAppIdsWithXeniaId.length} apps`);
					this.fetching = false;
					this.total = nonSteamAppIdsWithXeniaId.length;
					this.processed = 0;

					await Promise.map(nonSteamAppIdsWithXeniaId, async (app_id) => await this.refreshAchievementsForApp(app_id), {
						concurrency: 8
					});

					this.logger.log("Finished refreshing achievements");
					this.globalLoading = false;
					this.game = this.t("fetching");
					this.managerName = "";
					this.description = "";
					this.processed = 0;
					this.total = 0;
				}
			}
		} catch (e: any)
		{
			this.globalLoading = false;
			this.errored = true;
			this.description = `${e.constructor.name}: ${e.message}`;

			this.logger.error(e, `${e.constructor.name}: ${e.message}`);
		}
	}

	public isSupported(steamAppId: number): boolean {
		return (this.ids[steamAppId] != null || this.customIdsOverrides[steamAppId]?.xenia_title_id != null);
	}

	override isEnabled(): boolean {
		return this.state.settings.xenia.enabled !== false;
	}
}