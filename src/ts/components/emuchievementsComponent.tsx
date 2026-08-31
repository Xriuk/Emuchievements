import { CSSProperties, useEffect, useState, VFC } from "react";
import
{
	ButtonItem,
	Field,
	Navigation,
	PanelSection,
	PanelSectionRow,
	ProgressBar
} from "@decky/ui";
import { useEmuchievementsState } from "../hooks/achievementsContext";
import { FaCog, FaSync, FaTrash } from "react-icons/fa";
import { useTranslations } from "../useTranslations";
import React from "react";
import { getAllNonSteamAppIds } from "../steam-utils";
import { runInAction } from "mobx";
import Logger from "../logger";

export const SettingsButton: VFC = () =>
{
	const t = useTranslations();

	return (
		<ButtonItem
			layout="below"
			onClick={() =>
			{
				Navigation.CloseSideMenus();
				Navigation.Navigate("/emuchievements/settings");
			}}
		>
			<div style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
				<FaCog />
				<span style={{ marginLeft: "auto", textAlign: "right", width: "100%" }}>{t("settings")}</span>
			</div>
		</ButtonItem>
	);
};

export const RefreshButton: VFC = () =>
{
	const t = useTranslations();
	const { refresh } = useEmuchievementsState();

	return (
		<ButtonItem
			layout="below"
			onClick={() => 
			{
				void refresh();
			}}
		>
			<div style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
				<FaSync />
				<span style={{ marginLeft: "auto", textAlign: "right", width: "100%" }}>{t("refresh")}</span>
			</div>
		</ButtonItem>
	);
};

async function clearNonSteamAchivements(){
	let logger = new Logger("Clear");
	let ids = await getAllNonSteamAppIds();
	ids.forEach(appid => {
		let appData = appDetailsStore.GetAppData(appid);
		if(appData && !appData.bLoadingAchievments && appData.details?.achievements?.nTotal){
			logger.log("Clearing achievements", appData);
			runInAction(() =>
			{
				appData.details.achievements = {
					nAchieved: 0,
					nTotal: 0,
					vecAchievedHidden: [],
					vecHighlight: [],
					vecUnachieved: []
				};
				appDetailsCache.SetCachedDataForApp(appid, "achievements", 2, appData.details.achievements);
			});
		}
	});
}

export const CacheButton: VFC = () =>
{
	const t = useTranslations();
	const { managers: achievementManagers } = useEmuchievementsState();

	return (
		<ButtonItem 
			layout="below"
			onClick={async () => 
			{
				await clearNonSteamAchivements();
				achievementManagers.forEach(m => {
					m.clearCache();
					void m.saveCache();
				});
			}}
		>
			<div style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
				<FaTrash />
				<span style={{ marginLeft: "auto", textAlign: "right", width: "100%" }}>{t("clear")}</span>
			</div>
		</ButtonItem>
	);
};

export const LoadingProgressBar: VFC = () =>
{
	const t = useTranslations();
	const { loadingData } = useEmuchievementsState();
	const [css, setCss] = useState<CSSProperties>();
	useEffect(() =>
	{
		const def: CSSProperties = { };
		if (loadingData.errored) 
			def.color = "red";
		setCss(def);
	}, [loadingData]);
	return <>
		<Field
			label={t("loading")}
			description={loadingData.managerName + (!loadingData.fetching ? ` - ${loadingData.processed}/${loadingData.total}` : "")}
			bottomSeparator="none"
		/>
		<ProgressBar
			focusable={false}
			nProgress={loadingData.percentage}
			indeterminate={loadingData.fetching}
		/>
		<Field
			label={loadingData.game}
			description={
				<div style={css} className="ProgressBarDescription_debug">
					{(loadingData.errored) ? <>{t("error")}<br /></> : undefined}
					{loadingData.description}
				</div>}
			bottomSeparator="none"
		/>
	</>;
};

export const GameList: VFC = () =>
{
	const { apps, managers: achievementManagers } = useEmuchievementsState();
	const [appIds, setAppIds] = useState<number[]>();
	useEffect(() =>
	{
		apps.then(setAppIds);
	});

	return <>{appIds?.map(appId =>
	{
		// Fetch all the achievements for each appId.
		const achievements = achievementManagers.find(m => m.isEnabled() && m.isSupported(appId))
			?.fetchAchievementsProgress(appId);
		// If there are achievements, render them in a progress bar.
		if (achievements)
		{
			return (
				<PanelSectionRow key={appId}>
					<Field
						label={appStore.GetAppOverviewByAppID(appId).display_name}
						description={`${achievements.achieved}/${achievements.total}`}
						childrenLayout="below"
						onActivate={() =>
						{
							Navigation.Navigate(`/library/app/${appId}/achievements/my/individual`);
							Navigation.CloseSideMenus();
						}}>
						<ProgressBar
							focusable={false}
							nProgress={achievements.percentage}
						/>
					</Field>
				</PanelSectionRow>
			);
		} else return undefined;
	})}</>;
};

export const EmuchievementsComponent: VFC = () =>
{
	const { loadingData } = useEmuchievementsState();

	return (
		loadingData.globalLoading ?
			<PanelSection>
				<PanelSectionRow>
					<SettingsButton />
				</PanelSectionRow>
				<PanelSectionRow>
					<LoadingProgressBar />
				</PanelSectionRow>
			</PanelSection> : (loadingData.errored ?
				<PanelSection>
					<PanelSectionRow>
						<SettingsButton />
					</PanelSectionRow>
					<PanelSectionRow>
						<RefreshButton />
					</PanelSectionRow>
					<PanelSectionRow>
						<CacheButton />
					</PanelSectionRow>
					<PanelSectionRow>
						<LoadingProgressBar />
					</PanelSectionRow>
				</PanelSection> :
				<PanelSection>
					<PanelSectionRow>
						<SettingsButton />
					</PanelSectionRow>
					<PanelSectionRow>
						<RefreshButton />
					</PanelSectionRow>
					<PanelSectionRow>
						<CacheButton />
					</PanelSectionRow>
					<GameList />
				</PanelSection>)
	);
};