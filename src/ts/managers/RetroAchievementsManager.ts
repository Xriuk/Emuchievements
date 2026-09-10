import { sleep } from "@decky/ui";
import { call, fetchNoCors, toaster } from "@decky/api";
import { rawGameToGame, retroAchievementToSteamAchievement } from "../Mappers";
import
{
	checkOnlineStatus,
	getAllNonSteamAppIds,
	getAppDetails,
	waitForOnline,
} from "../steam-utils";
import { AllAchievements, GlobalAchievements } from "../SteamTypes";
import { Promise } from "bluebird";
import { CacheData } from "../settings";
import { GameInfoAndUserProgress, GetGameInfoAndUserProgressResponse } from "@retroachievements/api";
import { BaseManager, loadingFetchedAchievements, romRegex } from "./Manager";

export interface AchievementsData
{
	game: GameInfoAndUserProgress,
	last_updated_at: Date,
	game_id: number,
	md5: string;
}

/**
 * Retrieves achievements from RetroAchievements.org
 */
export class RetroAchievementsManager extends BaseManager<CacheData, AchievementsData>
{
	private hashes: Record<string, number> = {};

	protected getName(){
		return "RetroAchievements";
	}

	protected getCacheKey(){
		return "cache" as const;
	}

	protected async getStoreForGame(app_id: number): Promise<AchievementsData | undefined>
	{
		if (this.ids[app_id] === null && this.customIdsOverrides[app_id]?.retro_achivement_game_id === null) {
			return undefined;
		}

		const settings = this.state.settings;
		this.logger.debug(`${app_id} auth: `, settings.retroachievements.username, settings.retroachievements.api_key);

		await waitForOnline();
		const shortcut = await getAppDetails(app_id);
		this.logger.debug(`${app_id} shortcut: `, shortcut);
		let hash: string | null = null;

		if (shortcut)
		{
			const launchCommand = `${shortcut.strShortcutExe} ${shortcut.strShortcutLaunchOptions}`;
			this.logger.debug(`${app_id} launchCommand: `, launchCommand);
			const rom = launchCommand?.match(new RegExp(romRegex, "i"))?.[0];
			this.logger.debug(`${app_id} rom: `, rom);
			if (rom)
			{
				if (!this.customIdsOverrides) {
					this.customIdsOverrides = {}

					await this.saveCache();
				}

				if (!this.customIdsOverrides[app_id]) {
					this.ids[app_id] = null;
					this.customIdsOverrides[app_id] = {
						name: shortcut.strDisplayName,
						retro_achivement_game_id: null,
					}

					await this.saveCache();
				}

				if (this.customIdsOverrides[app_id] && this.customIdsOverrides[app_id]?.retro_achivement_game_id) {
					const { retro_achivement_game_id } = this.customIdsOverrides[app_id];
					this.ids[app_id] = retro_achivement_game_id;

					const getAppMd5Hash = () => {
						const { hash } = this.customIdsOverrides[app_id]

						if (typeof hash === 'string') {
							return hash
						}

						return Object.keys(this.hashes).find((md5) => this.hashes[md5] === retro_achivement_game_id);
					}

					const appMd5Hash = getAppMd5Hash();

					if (appMd5Hash) {
						hash = appMd5Hash

						// NOTE: If app does not have detected `hash` we save one, to improve performance in
						// future detects
						if (!this.customIdsOverrides[app_id]?.hash) {
							this.customIdsOverrides[app_id].hash = appMd5Hash;
						}

						const resolvedId = this.hashes[hash];
							if (resolvedId) {
								this.ids[app_id] = resolvedId;
							}
						}

					await this.saveCache();
				} else {
					const md5 = await call<[string], string>("hash", rom);
					this.logger.debug(`${app_id} md5: `, md5);
					if (md5 === "")
					{
						this.ids[app_id] = null;
						await this.saveCache();
						return undefined;
					} else
					{
						const gameId = this.hashes[md5];
						this.ids[app_id] = gameId ?? null;
						hash = md5;
						if (gameId) {
							this.customIdsOverrides[app_id].retro_achivement_game_id = gameId;
							this.customIdsOverrides[app_id].hash = md5;
						}
						await this.saveCache();
					}
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

		let game_id: number | undefined | null = this.ids[app_id];
		if (typeof game_id === "number" && game_id !== 0)
		{
			let retry = 0;
			let sleep_ms = 2000;
			while (retry < 5)
			{
				this.logger.debug(`${app_id} game_id: `, game_id);
				if (retry > 0)
				{
					await sleep(sleep_ms);
					sleep_ms *= 2;
				}
				const response = await fetchNoCors(
					`https://retroachievements.org/API/API_GetGameInfoAndUserProgress.php?z=${settings.retroachievements.username}&y=${settings.retroachievements.api_key}&u=${settings.retroachievements.username}&g=${game_id}`,
					{
						headers: {
							"User-Agent": `Emuchievements/${process.env.VERSION} (+https://github.com/EmuDeck/Emuchievements)`,
						},
					}
				);
				if (
					response.status == 429 ||
					response.status == 504 ||
					response.status == 500
				)
				{
					this.logger.debug(`response status was ${response.status}, retrying`, retry);
					retry++;
				} else if (response.status == 200)
				{
					const body = await response.text();
					const game = JSON.parse(body) as GetGameInfoAndUserProgressResponse;

					this.logger.debug(`${app_id} game: `, game);
					if (game_id && hash)
					{
						const result: AchievementsData = {
							game_id: game_id,
							game: rawGameToGame(game),
							md5: hash,
							last_updated_at: new Date(),
						};
						if (Object.keys(result.game?.achievements)?.length == 0)
						{
							return undefined;
						}
						this.store[app_id] = result;
						this.logger.debug(`${app_id} result:`, result);
						return result;
					} else
					{
						return undefined;
					}
				} else
				{
					this.logger.debug(`gameResponse: status ${response.status}`);
					throw new Error(`${response.status}`);
				}
			}
			throw new Error("Maximum retries exceeded");
		} else
		{
			return undefined;
		}
	}

	protected processStore(retro: AchievementsData)
	{
		if (Object.values(retro.game.achievements).length == 0)
		{
			return loadingFetchedAchievements;
		}

		const { achievements } = retro.game;

		const defaultAchievements: AllAchievements = {
			data: { achieved: {}, hidden: {}, unachieved: {} },
			loading: false,
		};

		const defaultGlobalAchievements: GlobalAchievements = {
			data: {},
			loading: false,
		};

		const { user, global } = Object.entries(achievements)
			.reduce((result, [_, achievement]) =>
			{
				this.logger.debug('Achievement: ', achievement);
				const steam = retroAchievementToSteamAchievement(achievement, retro.game, false /*this.state.settings.general.show_achieved_state_prefixes*/);

				if (result.user.data && result.global.data)
				{
					steam.bAchieved ?
						result.user.data.achieved[steam.strID] = steam :
						result.user.data.unachieved[steam.strID] = steam;

					result.global.data[steam.strID] = steam.flAchieved;
				}

				return result;
			}, { user: defaultAchievements, global: defaultGlobalAchievements });

		return { user, global };
	}

	public async refresh(): Promise<void>
	{
		try
		{
			this.errored = false
			if (!await checkOnlineStatus()){
				toaster.toast({
					title: `[${this.getName()}]: ${this.t("title")}`,
					body: this.t("noInternet"),
				});
				return;
			}

			if (await this.state.loggedIn)
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
					const nonSteamAppIdsWithRetroAchievementId = allNonSteamAppIds.filter((appId) => (this.ids[appId] !== null || this.customIdsOverrides[appId]?.retro_achivement_game_id !== null));
					this.logger.log(`${nonSteamAppIdsWithRetroAchievementId.length} apps have or might have RetroAchievements IDs`);

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
					this.logger.log(`Refreshing achievements for ${nonSteamAppIdsWithRetroAchievementId.length} apps`);
					this.fetching = false;
					this.total = nonSteamAppIdsWithRetroAchievementId.length;
					this.processed = 0;

					await Promise.map(nonSteamAppIdsWithRetroAchievementId, async (app_id) => await this.refreshAchievementsForApp(app_id), {
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
			} else
			{
				toaster.toast({
					title: `[${this.getName()}]: ${this.t("title")}`,
					body: this.t("noLogin"),
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

	public override async init(): Promise<void>
	{
		await this.loadCache();
		const response = await fetchNoCors("https://retroachievements.org/dorequest.php?r=hashlibrary", {
			headers: {
				"User-Agent": `Emuchievements/${process.env.VERSION} (+https://github.com/EmuDeck/Emuchievements)`,
			},
		});
		if (response.ok)
		{
			const body = await response.text();
			this.hashes = (
				JSON.parse(body.toLowerCase()) as { md5list: Record<string, number>; }
			).md5list;
		}
		if(this.isEnabled())
			await this.refresh();
	}

	public isSupported(steamAppId: number): boolean {
		return (this.ids[steamAppId] != null || this.customIdsOverrides[steamAppId]?.retro_achivement_game_id != null);
	}

	override isEnabled(): boolean {
		return this.state.settings.retroachievements.enabled !== false;
	}
}