import type { EmuchievementsState } from "../hooks/achievementsContext";
import type { AllAchievements, GlobalAchievements } from "../SteamTypes";

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