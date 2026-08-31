import throttledQueue from "throttled-queue";
import type { EmuchievementsState } from "../hooks/achievementsContext";
import type { AllAchievements, GlobalAchievements } from "../SteamTypes";
import { getTranslateFunc } from "../useTranslations";

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

export abstract class BaseManager implements Manager{
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

	protected readonly throttle = throttledQueue(4, 1000, true);

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

	public abstract init(): Promise<void>;
	public abstract deinit(): Promise<void>;
	public abstract refresh(): Promise<void>;

	public abstract clearCache(): void;
	public abstract saveCache(): Promise<void>;

	public abstract isSupported(steamAppId: number): boolean;
	public abstract isReady(steamAppId: number): boolean;
	public abstract fetchAchievements(steamAppId: number): FetchedAchievements;
	public abstract clearRuntimeCacheForAppId(steamAppId: number): void;

	public isEnabled(): boolean {
		return true;
	}
}