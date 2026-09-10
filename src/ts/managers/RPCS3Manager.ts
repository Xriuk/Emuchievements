import { call, fetchNoCors, toaster } from "@decky/api";
import
{
	checkOnlineStatus,
	getAllNonSteamAppIds,
	getAppDetails,
} from "../steam-utils";
import { AllAchievements, GlobalAchievements, type SteamAppAchievement } from "../SteamTypes";
import { Promise } from "bluebird";
import { RPCS3_USER_PATH_DEFAULT, type RPCS3CacheData } from "../settings";
import { BaseManager, romRegex } from "./Manager";
import { getUserTrophiesEarnedForTitle, type AuthTokensResponse, type UserThinTrophy } from "psn-api";

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
	progress?: Record<string, RPCS3TrophyStatus>,
	rarity?: UserThinTrophy[]
};

/**
 * Retrieves trophies from RPCS3 for installed games and folders, even not yet installed trophies
 * (for games which have not been run yet), and optionally retrieves trophies rarity from PSN
 */
export class RPCS3Manager extends BaseManager<RPCS3CacheData, RPCS3GameTrophies>
{
	private _psnTokens?: AuthTokensResponse;
	private _psnTokensExpiration?: Date;

	protected getName(){
		return "RPCS3";
	}

	protected getCacheKey(){
		return "rpcs3Cache" as const;
	}

	protected async getStoreForGame(app_id: number): Promise<RPCS3GameTrophies | undefined>
	{
		if (this.ids[app_id] === null && this.customIdsOverrides[app_id]?.rpcs3_trophy_id === null)
			return undefined;

		const user = (this.state.settings.rpcs3.user_path
			?? RPCS3_USER_PATH_DEFAULT);
		if(!user)
			return undefined;

		this.logger.debug(`${app_id} user: `, user);

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

			// If we found nothing we search the game folder
			let gameTrophies = false; // True if retrieved from game folder (0 achieved)
			if(!trophies.trophies.length){
				let locale = this.state.settings.rpcs3.locale ?? 'en';

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

			// Retrieve trophies icons and create grayscale versions for locked
			for(let trophy of trophies.trophies){
				trophy.icon = await call<[string, string, string], string>("rpcs3_get_trophy_icon_user", user, trophy_id, trophy.id) ?? '';
				
				if(!trophy.icon){
					if(romFolder)
						trophy.icon = await call<[string, string], string>("rpcs3_get_trophy_icon_game", romFolder + "/TROPDIR/" + trophy_id + "/TROPHY.TRP", trophy.id) ?? '';
					else if(gameId)
						trophy.icon = await call<[string, string], string>("rpcs3_get_trophy_icon_game", this.getHddPath() + "game/" + gameId + "/TROPDIR/" + trophy_id + "/TROPHY.TRP", trophy.id) ?? '';
				}
				
				// Create a locked grayscale version
				if(trophy.icon)
					trophy.locked_icon = await this.grayScaleIcon(trophy.icon);
				else
					trophy.locked_icon = '';
			}

			// Retrieve progress for non-game trophies (actually played)
			if(!gameTrophies){
				result = await call<[string, string], string>("rpcs3_get_all_trophies_status", user, trophy_id) ?? null;
				trophies.progress = JSON.parse(result ?? '{}') as Record<string, RPCS3TrophyStatus>;
				this.logger.debug(`${app_id} progress: `, trophies.progress);
			}
			else
				this.logger.debug(`${app_id} no progress yet`);

			// Retrieve trophies rarity
			if(this._psnTokens && await checkOnlineStatus()){
				// Refresh the token if needed
				if(this._psnTokensExpiration && new Date() >= this._psnTokensExpiration){
					try{
						this._psnTokens = await (await fetchNoCors('https://ca.account.sony.com/api/authz/v3/oauth', {
							method: 'POST',
							headers: {
								"Content-Type": "application/x-www-form-urlencoded",
								Authorization: "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A="
							},
							body: new URLSearchParams({
								refresh_token: this._psnTokens.refreshToken,
								grant_type: "refresh_token",
								token_format: "jwt",
								scope: "psn:mobile.v2.core psn:clientapp"
							}).toString()
						})).json()
					}
					catch(e){
						this.logger.debug(`${app_id} PSN token refresh error`, e);
						toaster.toast({
							title: `[${this.getName()}]: ${this.t("title")}`,
							body: this.t("rpcs3ErrorNpSSo")
						});
						this._psnTokens = undefined;
						this._psnTokensExpiration = undefined;
					}
				}

				if(this._psnTokens){
					// Try PSN accounts with most PS3 games/trophies in order (https://psnprofiles.com/leaderboard/ps3),
					// since PSN API requires an account to see trophies rarity but the we have no official user here...
					const psnAccounts = [
						'69542030923328854',
						'8477639012129454573',
						'7390413838940571081'
					];
					for(let accountId of psnAccounts){
						try{
							// npServiceName=trophy: PS3 trophies
							let rarity: Awaited<ReturnType<typeof getUserTrophiesEarnedForTitle>>  = await (await fetchNoCors(`https://m.np.playstation.com/api/trophy/v1/users/${accountId}/npCommunicationIds/${trophy_id}/trophyGroups/all/trophies?npServiceName=trophy`, {
								headers: {
									Authorization: `Bearer ${this._psnTokens.accessToken}`,
									"Content-Type": "application/json",
								},

							})).json();
							if(rarity.trophies.length){
								trophies.rarity = rarity.trophies;
								this.logger.debug(`${app_id} rarity: `, trophies.rarity);
								break;
							}
						}
						catch{ }
					}
				}
			}

			trophies.game ??= {};
			trophies.game.trophy_id = trophy_id;
			trophies.user = user;

			this.store[app_id] = trophies;
			return trophies;
		}
		
		return undefined;
	}

	protected processStore(store: RPCS3GameTrophies){
		const defaultAchievements: AllAchievements = {
			data: { achieved: {}, hidden: {}, unachieved: {} },
			loading: false,
		};

		const defaultGlobalAchievements: GlobalAchievements = {
			data: {},
			loading: false,
		};

		for(let trophy of store.trophies){
			this.logger.debug('Trophy: ', trophy);
			let achieved = store.progress?.[trophy.id]?.unlocked === true;

			let trophyIdInt = parseInt(trophy.id, 10);
			let rate: string | number | undefined = store.rarity?.find(t => t.trophyId === trophyIdInt)?.trophyEarnedRate;

			const steam: SteamAppAchievement = {
				bAchieved: achieved,
				bHidden: trophy.hidden === true,
				flAchieved: rate ? parseFloat(rate) : 0, // Percentage of players who achieved (0-100)
				flCurrentProgress: achieved ? 1 : 0, // Progress percentage of the player achievement (flMinProgress-flMaxProgress)
				flMaxProgress: 1,
				flMinProgress: 0,
				rtUnlocked: (achieved && store.progress?.[trophy.id]?.unlock_time_utc) ?
					store.progress[trophy.id].unlock_time_utc! :
					0, // Unlocked date timestamp
				strDescription: trophy.detail ?? '',
				strID: trophy.id,
				strImage: achieved ? trophy.icon : trophy.locked_icon,
				strName: trophy.name
			};

			if(this.state.settings.rpcs3.show_cat_prefixes !== false){
				switch(trophy.type){
				case 'B':
					steam.strDescription = "🟧 " + steam.strDescription;
					break;
				case 'S':
					steam.strDescription = "⬜ " + steam.strDescription;
					break;
				case 'G':
					steam.strDescription = "🟨 " + steam.strDescription;
					break;
				case 'P':
					steam.strDescription = "💎 " + steam.strDescription;
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
				if(!this.state.settings.rpcs3.npsso){
					toaster.toast({
						title: `[${this.getName()}]: ${this.t("title")}`,
						body: this.t("rpcs3NoNpSSo")
					});
				}
				else if(!await checkOnlineStatus()){
					toaster.toast({
						title: `[${this.getName()}]: ${this.t("title")}`,
						body: this.t("rpcs3NoInternetNpSSo")
					});
				}
				else{
					try{
						// DEV: https://github.com/SteamDeckHomebrew/decky-loader/issues/960
						const accessCodeResponse = await DeckyPluginLoader.legacyFetchNoCors('https://ca.account.sony.com/api/authz/v3/oauth/authorize?' + new URLSearchParams({
								access_type: "offline",
								client_id: "09515159-7237-4370-9b40-3806e67c0891",
								redirect_uri: "com.scee.psxandroid.scecompcall://redirect",
								response_type: "code",
								scope: "psn:mobile.v2.core psn:clientapp"
							}).toString(), {
								method: 'GET',
								headers: {
									Cookie: `npsso=${this.state.settings.rpcs3.npsso}`
								},
								allow_redirects: false
							});
						if(!accessCodeResponse.success || !accessCodeResponse.result.headers["Location"]?.includes("?code=")){
							throw new Error(`
								There was a problem retrieving your PSN access code. Is your NPSSO code valid?
								To get a new NPSSO code, visit https://ca.account.sony.com/api/v1/ssocookie.`);
						}
						const accessCode = new URLSearchParams(accessCodeResponse.result.headers["Location"]!.split("redirect/")[1]).get('code')!;
						/*const accessCodeResponse = await fetchNoCors('https://ca.account.sony.com/api/authz/v3/oauth/authorize?' + new URLSearchParams({
								access_type: "offline",
								client_id: "09515159-7237-4370-9b40-3806e67c0891",
								redirect_uri: "com.scee.psxandroid.scecompcall://redirect",
								response_type: "code",
								scope: "psn:mobile.v2.core psn:clientapp"
							}).toString(), {
							headers: {
								Cookie: `npsso=${this.state.settings.rpcs3.npsso}`
							},
							redirect: 'manual'
						});
						if(!accessCodeResponse.headers.get("location")?.includes("?code=")){
							throw new Error(`
								There was a problem retrieving your PSN access code. Is your NPSSO code valid?
								To get a new NPSSO code, visit https://ca.account.sony.com/api/v1/ssocookie.`);
						}
						const accessCode = new URLSearchParams(accessCodeResponse.headers.get("location")!.split("redirect/")[1]).get('code')!;*/

						const psnTokens = await (await fetchNoCors('https://ca.account.sony.com/api/authz/v3/oauth/token', {
							method: 'POST',
							headers: {
								"Content-Type": "application/x-www-form-urlencoded",
								Authorization: "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A="
							},
							body: new URLSearchParams({
								code: accessCode,
								redirect_uri: "com.scee.psxandroid.scecompcall://redirect",
								grant_type: "authorization_code",
								token_format: "jwt"
							}).toString()
						})).json();
						this._psnTokens = {
							accessToken: psnTokens.access_token,
							expiresIn: psnTokens.expires_in,
							idToken: psnTokens.id_token,
							refreshToken: psnTokens.refresh_token,
							refreshTokenExpiresIn: psnTokens.refresh_token_expires_in,
							scope: psnTokens.scope,
							tokenType: psnTokens.token_type
						};
						this._psnTokensExpiration = new Date();
						this._psnTokensExpiration.setSeconds(this._psnTokensExpiration.getSeconds() + this._psnTokens.expiresIn - 10);
					}
					catch{
						toaster.toast({
							title: `[${this.getName()}]: ${this.t("title")}`,
							body: this.t("rpcs3InvalidNpSSo")
						});
					}
				}

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

					this.managerName = this.getName();
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
					title: `[${this.getName()}]: ${this.t("title")}`,
					body: this.t("rpcs3NoUser")
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

	public isSupported(steamAppId: number): boolean {
		return (this.ids[steamAppId] != null || this.customIdsOverrides[steamAppId]?.rpcs3_trophy_id != null);
	}

	override isEnabled(): boolean {
		return this.state.settings.rpcs3.enabled !== false;
	}
}