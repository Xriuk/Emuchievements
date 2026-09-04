import
{
	afterPatch,
	beforePatch,
	callOriginal,
	findModuleExport,
	Patch,
	replacePatch,
	Router,
	staticClasses
} from "@decky/ui";
import { definePlugin, routerHook, type DeckyRequestInit } from "@decky/api";
import { FaClipboardCheck } from "react-icons/fa";
import { SettingsComponent } from "./components/settingsComponent";
import { EmuchievementsComponent } from "./components/emuchievementsComponent";
import { EmuchievementsState, EmuchievementsStateContextProvider } from "./hooks/achievementsContext";
import Logger from "./logger";
import
{
	AppDetailsStore, AppStore,
	CollectionStore,
	SteamAppOverview,
	type AppData
} from "./SteamTypes";
import { EventBus, MountManager } from "./System";
import { patchAppPage } from "./RoutePatches";
import { runInAction } from "mobx";
import { getTranslateFunc } from "./useTranslations";
import { StoreCategory } from "./managers/Manager";
declare global
{
	// @ts-ignore
	let SteamClient: SteamClient;
	let appStore: AppStore;
	// @ts-ignore
	let appDetailsStore: AppDetailsStore;

	let appDetailsCache: any;
	// let appDetailsCache: {
	// 	SetCachedDataForApp(appid: number, field: string, number: number, data: any): void;
	// };

	let appAchievementProgressCache: {
		m_achievementProgress: {
			nVersion: number,
			mapCache: Map<number, {
				all_unlocked: boolean,
				appid: number,
				cache_time: number,
				percentage: number,
				total: number,
				unlocked: number;
			}>;
		};
		RequestCacheUpdate(): Promise<void>;
		LoadCacheFile(): Promise<void>;
		SaveCacheFile(): Promise<void>;
	};

	let collectionStore: CollectionStore;

	// DEV: https://github.com/SteamDeckHomebrew/decky-loader/issues/960
	let DeckyPluginLoader: {
		legacyFetchNoCors(url: string, request?: DeckyRequestInit | any): Promise<{
			success: boolean;
			result: { status: number; headers: { [key: string]: string }; body: string } | any
		}>
	}
}

const AppDetailsSections = findModuleExport((mProp) => (
	typeof mProp === 'function' &&
	typeof mProp.prototype?.GetSections === 'function'
));

const Achievements = findModuleExport(mProp => mProp?.m_mapMyAchievements);

interface Hook
{
	unregister(): void;
}

export default definePlugin(function ()
{
	const t = getTranslateFunc();
	const logger = new Logger("Index");
	const state = new EmuchievementsState();
	let lifetimeHook: Hook;

	const eventBus = new EventBus();
	const mountManager = new MountManager(eventBus, logger);

	logger.debug(AppDetailsSections, Achievements);

	mountManager.addPageMount("/emuchievements/settings", () =>
		<EmuchievementsStateContextProvider emuchievementsState={state}>
			<SettingsComponent />
		</EmuchievementsStateContextProvider>
	);

	// DEV: What is this?
	mountManager.addPatchMount({
		patch(): Patch
		{
			return replacePatch(
				Achievements.__proto__,
				"LoadMyAchievements",
				args =>
				{
					logger.debug("LoadMyAchievements");
					//console.log(args, appStore.GetAppOverviewByAppID(args[0]), appDetailsStore.GetAppDetails(args[0]));
					if (appStore.GetAppOverviewByAppID(args[0])?.app_type === 1073741824 && !Achievements.m_mapGlobalAchievements.has(args[0]))
					{
						let manager = state.managers.find(m => m.isEnabled() && m.isSupported(args[0]));
						if(manager){
							let data = manager.fetchAchievements(args[0]);
							logger.debug(data.global);
							if (!data.global.loading)
								Achievements.m_mapGlobalAchievements.set(args[0], data.global);
							logger.debug(data.user);
							if (!data.user.loading)
								Achievements.m_mapMyAchievements.set(args[0], data.user);
						}
						return;
					}
					return callOriginal;
				}
			);
		}
	});

	// Adds games to Library filter where achievements are supported
	mountManager.addPatchMount({
		patch(): Patch
		{
			return replacePatch(
				// @ts-ignore
				appStore.allApps[0].__proto__,
				"BHasStoreCategory",
				function (args)
				{
					logger.debug("BHasStoreCategory", this, args);
					// @ts-ignore
					if ((this as SteamAppOverview).app_type == 1073741824)
					{
						// @ts-ignore
						if (state.settings.general.store_category &&
							state.managers.some(m => m.isReady((this as SteamAppOverview).appid)) &&
							args[0] === StoreCategory.Achievements)
						{
							return true;
						}
					}
					return callOriginal;
				}
			);
		}
	});

	function setAchievements(appid: number){
		let appData = appDetailsStore.GetAppData(appid);
		setAchievementsAppData(appid, appData);
	}
	function setAchievementsAppData(appid: number, appData: AppData | null){
		if (appData && !appData.bLoadingAchievments && appData.details?.achievements.nTotal === 0)
		{
			appData.bLoadingAchievments = true;
			let manager = state.managers.find(m => m.isEnabled() && m.isSupported(appid));
			if(manager){
				const achievements = manager.fetchAchievements(appid);
				if (achievements.user.data)
				{
					const nAchieved = Object.keys(achievements.user.data.achieved).length;
					const nTotal = Object.keys(achievements.user.data.achieved).length +
						Object.keys(achievements.user.data.unachieved).length +
						Object.keys(achievements.user.data.hidden).length;
					const vecHighlight = Object.values(achievements.user.data.achieved).filter(a => a.bHidden !== true);
					const vecAchievedHidden = Object.values(achievements.user.data.achieved).filter(a => a.bHidden === true);
					const vecUnachieved = Object.values(achievements.user.data.unachieved);
					runInAction(() =>
					{
						appData.details.achievements = {
							nAchieved,
							nTotal,
							vecAchievedHidden,
							vecHighlight,
							vecUnachieved
						};
						logger.debug("achievementsCachedData", appData.details.achievements);
						appDetailsCache.SetCachedDataForApp(appid, "achievements", 2, appData.details.achievements);
					});
				}
			}
			appData.bLoadingAchievments = false;
		}
	}

	// Set achievements on appDetailsStore (Used to show on game launch page and in the in-game overlay menu)
	mountManager.addPatchMount({
		patch(): Patch
		{
			return afterPatch(
				appDetailsStore,
				"GetAppData",
				(args, appData) =>
				{
					logger.debug('GetAppData');

					setAchievementsAppData(args[0], appData);

					return appData;
				}
			);
		}
	});

	// DEV: What is this?
	mountManager.addPatchMount({
		patch(): Patch
		{
			return beforePatch(
				Router,
				"BIsStreamingRemotePlayTogetherGame",
				_ =>
				{
					logger.debug('BIsStreamingRemotePlayTogetherGame');
					if (state.managers.some(m => m.isReady((Router.MainRunningApp as SteamAppOverview | undefined)?.appid ?? 0)))
					{
						setAchievements((Router.MainRunningApp as SteamAppOverview | undefined)?.appid ?? 0);
					}
				}
			);
		}
	});

	// Achievements section on app details page
	mountManager.addPatchMount({
		patch(): Patch
		{
			return afterPatch(AppDetailsSections?.prototype, 'GetSections', function(this: any, _: Record<string, unknown>[], ret: Set<string>)
			{
				const overview: SteamAppOverview = this?.props?.overview;
				if (overview?.app_type === 1073741824)
				{
					if (state.settings.general.game_page) ret.add("achievements");
					else ret.delete("achievements");
				}
				return ret;
			});
		}
	});

	// Refresh achievements on app close
	mountManager.addMount({
		mount: function (): void
		{
			lifetimeHook = SteamClient.GameSessions.RegisterForAppLifetimeNotifications((update: {
				unAppID: number;
				nInstanceID: number;
				bRunning: boolean;
			}) =>
			{
				logger.debug("lifetime", update);
				if ((appStore.GetAppOverviewByAppID(update.unAppID) as SteamAppOverview).app_type == 1073741824)
				{
					if (!update.bRunning)
					{
						let manager = state.managers.find(m => m.isEnabled() && m.isSupported(update.unAppID));
						if(manager){
							manager.clearRuntimeCacheForAppId(update.unAppID);
							manager.fetchAchievements(update.unAppID);
						}
					}
				}
			});
		},
		unMount: function (): void
		{
			lifetimeHook?.unregister();
		}
	});

	// DEV: add refresh achievements on overlay open

	mountManager.addMount(patchAppPage(state));

	mountManager.addMount({
		mount: async function (): Promise<void>
		{
			await state.init();
		},
		unMount: async function (): Promise<void>
		{
			await state.deinit();
		}
	});

	const unregister = mountManager.register();

	return {
		name: t("title"),
		titleView: <div className={staticClasses.Title}>{t("title")}</div>,
		content:
			<EmuchievementsStateContextProvider emuchievementsState={state}>
				<EmuchievementsComponent />
			</EmuchievementsStateContextProvider>,
		icon: <FaClipboardCheck />,
		onDismount()
		{
			routerHook.removeRoute("/emuchievements/settings");
			unregister();
		},
	};
});