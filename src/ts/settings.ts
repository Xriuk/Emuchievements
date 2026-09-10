import {Mutex} from "async-mutex";
import {findInTree} from "@decky/ui";
import { call, toaster } from "@decky/api";
import {EmuchievementsState} from "./hooks/achievementsContext";
import Logger from "./logger";
import {getTranslateFunc} from "./useTranslations";

export type SettingsData = {
	config_version: string,
	general: GeneralData,

	retroachievements: RetroAchievementsData,
	rpcs3?: RPCS3Data,
	xenia?: XeniaData,

	cache: CacheData,
	rpcs3cache?: RPCS3CacheData,
	xeniacache?: XeniaCacheData
};

export type RetroAchievementsData = {
	enabled?: boolean, // defaults to true
	username: string,
	api_key: string,
	logged_in?: boolean,
};

export const RPCS3_USER_PATH_DEFAULT = "/home/deck/Emulation/storage/rpcs3/dev_hdd0/home/00000001";

export type RPCS3Data = {
	enabled?: boolean, // defaults to true
	user_path?: string, // defaults to RPCS3_USER_PATH_DEFAULT
	locale?: string, // defaults to "en"
	show_cat_prefixes?: boolean, // defaults to true
	npsso?: string, // 64-chars token to access PSN API
};

export type XeniaData = {
	enabled?: boolean, // defaults to true
	user_path?: string, // like "/home/deck/Emulation/roms/xbox360/content/<A010000011AA1111>/FFFE07D1/00010000/<A010000011AA1111>"
	locale?: string, // defaults to "en"
	show_gamerscore?: boolean, // defaults to true
	show_description_locked?: boolean, // undefined: show locked/unlocked, true: show locked, false: show unlocked
};


export type CustomIdsOverrides = {
	/**
	 * Game name
	 */
	name: string | null,
	/**
	 * RetroAchievements supported game files hash.
	 * Can be found on URL: `https://retroachievements.org/game/xyz/hashes` where `xyz` is Game ID
	 */
	hash?: string | null,
	/**
	 * RetroAchievement Game ID.
	 */
	retro_achivement_game_id: number | null,
}
export type CacheData = {
	ids: Record<number, number | null>,
	custom_ids_overrides: Record<number, CustomIdsOverrides>,
};

export type RPCS3CustomIdsOverrides = {
	/**
	 * Game name
	 */
	name: string | null;
	/**
	 * Trophies ID (eg: NPWR00214_00)
	 */
	rpcs3_trophy_id: string | null;
	/**
	 * Game ID (eg: BCES00129, might be null for disc games)
	 */
	rpcs3_game_id?: string | null;
}
export type RPCS3CacheData = {
	ids: Record<number, string | null>,
	custom_ids_overrides: Record<number, RPCS3CustomIdsOverrides>,
};

export type XeniaCustomIdsOverrides = {
	/**
	 * Game name
	 */
	name: string | null;
	/**
	 * Title Id (eg: 545107D1)
	 */
	xenia_title_id: string | null;
	/**
	 * Full path of the rom (ISO, ...)
	 */
	xenia_rom_path: string | null;
}
export type XeniaCacheData = {
	ids: Record<number, string | null>,
	custom_ids_overrides: Record<number, XeniaCustomIdsOverrides>,
};


export type GeneralData = {
	game_page: boolean,
	store_category: boolean,
	/**
	 * Enabled or disable showing prefixes like `[ACHIEVED]` & `[NOT ACHIEVED]`
	 */
	show_achieved_state_prefixes: boolean,
};

export const CONFIG_VERSION = "1.1.0";

const DEFAULT_CONFIG: SettingsData = {
	config_version: CONFIG_VERSION,
	retroachievements: {
		username: "",
		api_key: "",
	},
	cache: {
		ids: {},
		custom_ids_overrides: {},
	},
	general: {
		game_page: true,
		store_category: true,
		show_achieved_state_prefixes: true,
	},
};


const findOldConfigKey = (config: any, search: string): any =>
{
	return findInTree(config, (x: any) =>
		   {
			   if (typeof x == "object")
			   {
				   for (let key in x)
				   {
					   if (key == search)
					   {
						   return true
					   }
				   }
			   }
			   return false
		   }
		   , {})[search];
}

export class Settings
{
	private readonly state: EmuchievementsState;
	private readonly logger: Logger = new Logger("Settings");
	private readonly mutex: Mutex = new Mutex();
	private readonly packet_size: number = 2048;
	data: SettingsData = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
	last_data = '';
	
	get general(): GeneralData
	{
		return this.get("general");
	}
	set general(general: GeneralData)
	{
		this.set("general", general);
	}


	get retroachievements(): RetroAchievementsData
	{
		return this.get("retroachievements");
	}
	set retroachievements(retroachievements: RetroAchievementsData)
	{
		this.set("retroachievements", retroachievements);
	}

	get rpcs3(): RPCS3Data
	{
		return this.getOrSet("rpcs3", {});
	}
	set rpcs3(rpcs3: RPCS3Data)
	{
		this.set("rpcs3", rpcs3);
	}

	get xenia(): XeniaData
	{
		return this.getOrSet("xenia", {});
	}
	set xenia(xenia: XeniaData)
	{
		this.set("xenia", xenia);
	}


	get cache(): CacheData
	{
		return this.get("cache");
	}
	set cache(cache: CacheData)
	{
		this.set("cache", cache);
	}

	get rpcs3Cache(): RPCS3CacheData
	{
		return this.getOrSet("rpcs3cache", {
			ids: {},
			custom_ids_overrides: {}
		});
	}
	set rpcs3Cache(cache: RPCS3CacheData)
	{
		this.set("rpcs3cache", cache);
	}

	get xeniaCache(): XeniaCacheData
	{
		return this.getOrSet("xeniacache", {
			ids: {},
			custom_ids_overrides: {}
		});
	}
	set xeniaCache(cache: XeniaCacheData)
	{
		this.set("xeniacache", cache);
	}


	constructor(state: EmuchievementsState)
	{
		this.state = state;
	}

	set<T extends keyof SettingsData>(key: T, value: SettingsData[T])
	{
		this.data[key] = value;
		void this.writeSettings();
		this.state.notifyUpdate();
		return this;
	}

	setMultiple(settings: SettingsData)
	{
		(Object.keys(settings) as (keyof SettingsData)[]).forEach((key: keyof SettingsData) =>
		{
			this.set(key, settings[key]);
		});
		return this;
	}

	get<T extends keyof SettingsData>(key: T): SettingsData[T]
	{
		return this.data[key];
	}

	private getOrSet<T extends keyof SettingsData>(key: T, def: NonNullable<SettingsData[T]>): NonNullable<SettingsData[T]>{
		let data = this.get(key);
		if(!data){
			data = def;
			this.set(key, data);
		}
		return data as any;
	}

	async readSettings(): Promise<void>
	{
		let needsWrite = false;
		const release = await this.mutex.acquire();
		try
		{
			let buffer = "";
			const length = await call<[number], number>("start_read_config", this.packet_size);
			for (let i = 0; i < length; i++)
			{
				buffer += await call<[number], string>("read_config", i);
			}
			this.logger.debug("readSettings", buffer);
			const data: SettingsData = JSON.parse(buffer);
			if (data.config_version !== CONFIG_VERSION)
			{
				const t = getTranslateFunc();
				toaster.toast({
					title: t("title"),
					body: t("settingsReset")
				});

				const username: string = findOldConfigKey(data, "username")
				const api_key: string = findOldConfigKey(data, "api_key")

				this.data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

				this.data.retroachievements.username = username
				this.data.retroachievements.api_key = api_key

				needsWrite = true;
			} else
			{
				this.data = data;
			}

			this.last_data = JSON.stringify(this.data);
		} finally
		{
			release();
		}
		if (needsWrite) await this.writeSettings();
	}

	async writeSettings(): Promise<void>
	{
		const release = await this.mutex.acquire();
		try
		{
			// Check if configuration changed from last, otherwise skip
			const buffer = JSON.stringify(this.data);
			if(buffer === this.last_data)
				return;

			const length = Math.ceil(buffer.length / this.packet_size);
			await call<[number, number], void>("start_write_config", length, this.packet_size);
			for (let i = 0; i < length; i++)
			{
				const data = buffer.slice(i * this.packet_size, (i + 1) * this.packet_size);
				await call<[number, string], void>("write_config", i, data);
			}

			this.last_data = buffer;
		} finally
		{
			release();
		}
	}
}