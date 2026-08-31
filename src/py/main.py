import json
import logging
import math
import os
import subprocess
import decky_plugin
import xmltodict
import struct
import base64
from typing import Dict, Optional, Tuple

logging.basicConfig(
	filename="/tmp/emuchievements.log",
	format='[Emuchievements] %(asctime)s %(levelname)s %(message)s',
	filemode='w+',
	force=True
)
logger = logging.getLogger()
logger.setLevel(logging.DEBUG)  # can be changed to logging.DEBUG for debugging issues

TROPHYTRP_ENTRY_SIZE = 64
TROPHYTRP_MAX_ENTRIES = 4096
TROPHYTRP_HEADER_SIZE_V1 = 48
TROPHYTRP_HEADER_SIZE_V2 = 64
TROPHYTRP_MAGIC = b"\xDC\xA2\x4D\x00"

TROPUSR_HEADER_SIZE = 48
TROPUSR_TABLE_HEADER_SIZE = 32
TROPUSR_MAGIC = b"\x81\x8F\x54\xAD"
TROPHY_STATE_ENTRY_HEADER_SIZE = 10
TROPHY_STATE_TABLE_TYPE = 6
TROPHY_STATE_ENTRY_CONTENTS_SIZE = 96
TROPHY_STATE_ENTRY_SIZE = TROPHY_STATE_ENTRY_HEADER_SIZE + TROPHY_STATE_ENTRY_CONTENTS_SIZE

class Plugin:
	packet_size: int = 1000
	length: int = 0
	buffer: str = ""
	runner = None

	async def start_write_config(self, length, packet_size = 1000) -> None:
		Plugin.buffer = ""
		Plugin.length = length
		Plugin.packet_size = packet_size

	async def write_config(self, index, data) -> None:
		Plugin.buffer += data
		if index >= Plugin.length - 1:
			Plugin.length = 0
			config = json.loads(Plugin.buffer)
			Plugin.buffer = ""
			with open(os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "settings.json"), "w") as f:
				try:
					json.dump(config, f, indent="\t")
				except Exception as e:
					raise Exception(Plugin.buffer)

	async def start_read_config(self, packet_size = 1000) -> int:
		Plugin.buffer = ""
		Plugin.length = 0
		Plugin.packet_size = packet_size
		with open(os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "settings.json"), "r") as f:
			config = json.load(f)
			Plugin.buffer = json.dumps(config)
			Plugin.length = math.ceil(len(Plugin.buffer) / float(Plugin.packet_size))
			return Plugin.length

	async def read_config(self, index) -> str:
		if index < Plugin.length - 1:
			return Plugin.buffer[index * Plugin.packet_size : (index + 1) * Plugin.packet_size]
		else:
			Plugin.length = 0
			config =  Plugin.buffer[index * Plugin.packet_size :]
			Plugin.buffer = ""
			return config

	async def hash(self, path: str) -> str:
		# lib = ctypes.CDLL(f"{helpers.get_homebrew_path(helpers.get_home_path(helpers.get_user()))}/plugins/{plugin}/bin/Emuchievements.so")
		# hash = lib.hash
		# hash.argtypes = [ctypes.c_char_p]
		# hash.restype = ctypes.c_char_p
		# return hash(path.encode('utf-8'))

		# return os.popen(
		# 	f"'{os.path.join(decky_plugin.DECKY_PLUGIN_DIR, 'bin', 'hash')}' \"{path}\"").read().strip()

		logger.debug(f"Hashing ROM: {path}")
		try:
			# Fix PyInstaller Library Issue as Per: https://github.com/xXJSONDeruloXx/Decky-Framegen/
			clean_env = os.environ.copy()
			clean_env["LD_LIBRARY_PATH"] = ""

			hash_bin = os.path.join(decky_plugin.DECKY_PLUGIN_DIR, "bin", "hash")

			cmd = [hash_bin, path]

			result = subprocess.run(
				cmd,
				env=clean_env,
				capture_output=True,
				text=True,
				check=True
			)
			hash_result = result.stdout.strip()
			logger.debug(f"Hash result for {path}: {hash_result}")
			return hash_result
		except subprocess.CalledProcessError as e:
			logger.error(f"Error hashing ROM {path}: exit {e.returncode}, stderr: {e.stderr.strip()}")
		except Exception as e:
			logger.error(f"Error hashing ROM {path}: {e}")
			raise

	async def log_frontend(self, level: str, message: str) -> None:
		if level == "error":
			logger.error(f"[frontend] {message}")
		elif level == "warn":
			logger.warning(f"[frontend] {message}")
		else:
			logger.info(f"[frontend] {message}")

	async def reset(self) -> None:
		Plugin.length = 0
		Plugin.buffer = ""
		Plugin.packet_size = 1000

	async def rpcs3_check_user_path(self, user_path: str) -> bool:
		return os.path.isdir(user_path)
	
	# REF: https://github.com/justin-delano/PlayniteAchievements/blob/24b1bcab770277a645ef93f52795823739e0ae0e/source/Providers/RPCS3/Rpcs3TrophyParser.cs#L789
	async def rpcs3_locale_to_ps3(self, locale: str) -> int:
		match locale.lower():
			case "ja": return 0
			case "en": return 1
			case "fr": return 2
			case "es": return 3
			case "de": return 4
			case "it": return 5
			case "nl": return 6
			case "pt": return 7
			case "ru": return 8
			case "ko": return 9
			case "zh": return 11 # Simplified Chinese; 10 is Traditional
			case "fi": return 12
			case "sv": return 13
			case "da": return 14
			case "no": return 15
			case "pl": return 16
			case "pt-br": return 17
			case "tr": return 19

		return None

	# REF: https://github.com/justin-delano/PlayniteAchievements/blob/24b1bcab770277a645ef93f52795823739e0ae0e/source/Providers/RPCS3/Rpcs3TrpArchiveReader.cs#L46
	async def parse_trp_directory(self, trp_bytes: bytes) -> Dict[str, Tuple[int, int]]:
		magic = trp_bytes[0:4]
		if magic != TROPHYTRP_MAGIC:
			raise ValueError(f"Invalid TRP magic header: {magic.hex()}")

		# Header unpacked according to PS3 TRP structure (Big-Endian)
		# Magic (4B), Version (4B), File size (8B), Element Count (4B)...
		_, version, _, element_count = struct.unpack(
			">4sIQI", trp_bytes[0:20]
		)

		if element_count > TROPHYTRP_MAX_ENTRIES:
			raise ValueError("Too many entries in TRP archive.")

		header_candidates = [ TROPHYTRP_HEADER_SIZE_V2, TROPHYTRP_HEADER_SIZE_V1 ] if version >= 2 else [ TROPHYTRP_HEADER_SIZE_V1, TROPHYTRP_HEADER_SIZE_V2 ]
		header_size = -1
		for candidate in header_candidates:
			if header_size != -1 or candidate + (element_count * TROPHYTRP_ENTRY_SIZE) > len(trp_bytes):
				continue

			character = False
			terminated = False
			for i in range(TROPHYTRP_ENTRY_SIZE):
				value = trp_bytes[candidate + i]
				if value == 0:
					terminated = True
				elif terminated or value < 0x20 or value > 0x7E:
					break
				else:
					character = True
			
			if character and terminated:
				header_size = candidate

		if header_size == -1:
			raise ValueError("Invalid TRP archive header.")

		file_directory = {}
		current_offset = header_size

		for _ in range(element_count):
			entry_data = trp_bytes[current_offset : current_offset + TROPHYTRP_ENTRY_SIZE]
			if len(entry_data) < TROPHYTRP_ENTRY_SIZE:
				break

			# 32-byte null-padded filename, 8-byte offset, 8-byte size
			raw_name, offset, size = struct.unpack(">32sQQ", entry_data[0:48])
			filename = raw_name.split(b"\x00")[0].decode("ascii", errors="ignore")

			file_directory[filename] = (offset, size)
			current_offset += TROPHYTRP_ENTRY_SIZE

		return file_directory

	async def rpcs3_get_trophy_dir_path(self, rom_path: str) -> str:
		if rom_path is None or rom_path == "":
			return None
			
		dir = rom_path + "/TROPDIR"
		if not os.path.isdir(dir):
			return None

		children = next(os.walk(dir))[1]
		if len(children) != 1:
			return None
		else:
			return children[0]

	async def rpcs3_get_all_trophies_file(self, file_bytes: bytes):
		result = {
			'trophies': []
		}

		trophyconf = xmltodict.parse(file_bytes)['trophyconf']
		if 'title-name' in trophyconf:
			if not 'game' in result:
				result['game'] = {}
			result['game']['name'] = trophyconf['title-name']
		if 'title-detail' in trophyconf:
			if not 'game' in result:
				result['game'] = {}
			result['game']['detail'] = trophyconf['title-detail']
		if 'trophy' in trophyconf:
			for trophy in trophyconf['trophy']:
				result['trophies'].append({
					'id': trophy['@id'],
					'hidden': trophy['@hidden'] != 'no' if '@hidden' in trophy else None,
					'type': trophy['@ttype'],
					'name':  trophy['name'] if 'name' in trophy else '',
					'detail':  trophy['detail'] if 'detail' in trophy else ''
				})

		return result

	async def rpcs3_get_all_trophies_user(self, user_path: str, trophy_id: str) -> str:
		path = user_path + "/trophy/" + trophy_id + "/TROPCONF.SFM"
		if not os.path.isfile(path):
			result = {'trophies': []}
			return json.dumps(result)

		with open(path, 'r') as file:
			return json.dumps(await Plugin.rpcs3_get_all_trophies_file(self, file.read()))
	
	async def rpcs3_get_all_trophies_game(self, trp_path: str, locale: str) -> str:
		result = {'trophies': []}

		trp_bytes = None
		trp = {}
		try:
			with open(trp_path, 'rb') as file:
				trp_bytes = file.read()
				trp = await Plugin.parse_trp_directory(self, trp_bytes)
		except:
			return json.dumps(result)

		ps3_locale = await Plugin.rpcs3_locale_to_ps3(self, locale)
		if not ps3_locale is None:
			ps3_locale = str(ps3_locale).zfill(2)
		else:
			ps3_locale = '01'

		# Load info from TROPCONF.SFM
		if 'TROPCONF.SFM' in trp:
			entry = trp['TROPCONF.SFM']
			result = await Plugin.rpcs3_get_all_trophies_file(self, trp_bytes[entry[0]:entry[0] + entry[1]])

		# Try retrieving a language or English
		if 'trophies' in result and len(result['trophies']) > 0:
			lang_result = {'trophies': []}
			if f'TROP_{ps3_locale}.SFM' in trp:
				entry = trp[f'TROP_{ps3_locale}.SFM']
				lang_result = await Plugin.rpcs3_get_all_trophies_file(self, trp_bytes[entry[0]:entry[0] + entry[1]])
			elif 'TROP.SFM' in trp:
				entry = trp['TROP.SFM']
				lang_result = await Plugin.rpcs3_get_all_trophies_file(self, trp_bytes[entry[0]:entry[0] + entry[1]])

			if 'game' in lang_result and 'game' in result:
				if 'name' in lang_result['game']:
					result['game']['name'] = lang_result['game']['name']
				if 'detail' in lang_result['game']:
					result['game']['detail'] = lang_result['game']['detail']

			if 'trophies' in lang_result and len(lang_result['trophies']) > 0:
				for trophy in lang_result['trophies']:
					if not 'id' in trophy:
						continue
					
					for original_trophy in result['trophies']:
						if 'id' in original_trophy and original_trophy['id'] == trophy['id']:
							if 'name' in trophy:
								original_trophy['name'] = trophy['name']
							if 'detail' in trophy:
								original_trophy['detail'] = trophy['detail']
							break

		return json.dumps(result)

	async def rpcs3_get_trophy_icon_user(self, user_path: str, trophy_id: str, id: str) -> str:
		path = user_path + "/trophy/" + trophy_id + "/TROP" + id + ".PNG"
		if not os.path.isfile(path):
			return ''
		
		with open(path, "rb") as image_file:
			encoded_string = base64.b64encode(image_file.read()).decode('utf-8')
			return "data:image/png;base64," + encoded_string

	async def rpcs3_get_trophy_icon_game(self, trp_path: str, id: str) -> str:
		trp_bytes = None
		trp = {}
		try:
			with open(trp_path, 'rb') as file:
				trp_bytes = file.read()
				trp = await Plugin.parse_trp_directory(self, trp_bytes)
		except:
			return ''
		
		if f'TROP{id}.PNG' in trp:
			entry = trp[f'TROP{id}.PNG']
			encoded_string = base64.b64encode(trp_bytes[entry[0]:entry[0] + entry[1]]).decode('utf-8')
			return "data:image/png;base64," + encoded_string
		else:
			return ''

	async def rpcs3_get_all_trophies_status(self, user_path: str, trophy_id: str) -> str:
		parsed_states = {}

		path = user_path + "/trophy/" + trophy_id + "/TROPUSR.DAT"
		if not os.path.isfile(path):
			return json.dumps(parsed_states)

		data = None
		with open(path, 'rb') as file:
			data = file.read()

		if data is None or len(data) < TROPUSR_HEADER_SIZE:
			raise ValueError("file is shorter than the TROPUSR header")

		magic = data[0:4]
		if magic != TROPUSR_MAGIC:
			raise ValueError("unexpected file magic " + magic.hex())

		table_count = struct.unpack_from(">I", data, 8)[0]
		max_tables = (len(data) - TROPUSR_HEADER_SIZE) // TROPUSR_TABLE_HEADER_SIZE
		if table_count == 0 or table_count > max_tables:
			raise ValueError("invalid table count " + table_count)

		table6_seen = False

		for table_index in range(table_count):
			table_offset = TROPUSR_HEADER_SIZE + (table_index * TROPUSR_TABLE_HEADER_SIZE)
			if (TROPUSR_TABLE_HEADER_SIZE < 0 or
				table_offset > len(data) or
				TROPUSR_TABLE_HEADER_SIZE > len(data) - table_offset):
				raise ValueError("table header extends beyond the file")

			table_type, contents_size = struct.unpack_from(">II", data, table_offset)
			entry_count = struct.unpack_from(">I", data, table_offset + 12)[0]
			entries_offset = struct.unpack_from(">Q", data, table_offset + 16)[0]

			if contents_size > 0x7FFFFFFF - TROPHY_STATE_ENTRY_HEADER_SIZE:
				raise ValueError("entry size is too large")

			entry_size = contents_size + TROPHY_STATE_ENTRY_HEADER_SIZE
			bytes_len = len(data)

			if (entry_size <= 0 or 
				entries_offset > bytes_len or 
				(entry_count > 0 and (
					entry_size > bytes_len or 
					entry_count > (bytes_len - entries_offset) // entry_size
				))):
				raise ValueError("table entries extend beyond the file")

			if table_type != TROPHY_STATE_TABLE_TYPE:
				continue

			if table6_seen or contents_size != TROPHY_STATE_ENTRY_CONTENTS_SIZE:
				msg = "multiple trophy-state tables" if table6_seen else "unexpected trophy-state entry size"
				raise ValueError(msg)

			table6_seen = True
			for entry_index in range(entry_count):
				entry_offset = entries_offset + (entry_index * TROPHY_STATE_ENTRY_SIZE)
				if (TROPHY_STATE_ENTRY_SIZE < 0 or
					entry_offset > len(data) or
					TROPHY_STATE_ENTRY_SIZE > len(data) - entry_offset):
					raise ValueError("trophy-state entry extends beyond the file")

				entry_type, entry_contents_size = struct.unpack_from(">II", data, entry_offset)
				if entry_type != TROPHY_STATE_TABLE_TYPE or entry_contents_size != TROPHY_STATE_ENTRY_CONTENTS_SIZE:
					raise ValueError("invalid trophy-state entry header")

				trophy_id = struct.unpack_from(">I", data, entry_offset + 16)[0]
				if trophy_id > 0x7FFFFFFF or trophy_id in parsed_states:
					msg = "trophy id is out of range" if trophy_id > 0x7FFFFFFF else "duplicate trophy id"
					raise ValueError(msg)

				trophy_state = struct.unpack_from(">I", data, entry_offset + 20)[0]
				timestamp2 = struct.unpack_from(">Q", data, entry_offset + 40)[0]
				unlock_time_utc = None

				if trophy_state != 0 and timestamp2 > 0:
					# C# Ticks max value conversion check (100-nanosecond ticks)
					if timestamp2 > 315537897599999999:
						raise ValueError("unlock timestamp is out of range")
					
					# Convert 100-ns ticks (timestamp2 * 10) to Python datetime
					dot_net_epoch = datetime(1, 1, 1, tzinfo=timezone.utc)
					unlock_time_utc = dot_net_epoch + timedelta(microseconds=(timestamp2 * 10) // 10)

				parsed_states[trophy_id] = {
					'unlocked': (trophy_state != 0),
					'unlock_time_utc': unlock_time_utc
				}

		if not table6_seen:
			raise ValueError("trophy-state table is missing")

		return json.dumps(parsed_states)

	def _find_flatpak(self) -> str:
		for candidate in ["/usr/bin/flatpak", "/usr/local/bin/flatpak", "/run/host/usr/bin/flatpak"]:
			if os.path.isfile(candidate):
				return candidate
		try:
			result = subprocess.run(["which", "flatpak"], capture_output=True, text=True)
			if result.returncode == 0:
				return result.stdout.strip()
		except Exception:
			pass
		return ""

	async def _log_tool_versions(self):
		hash_bin = os.path.join(decky_plugin.DECKY_PLUGIN_DIR, "bin", "hash")
		logger.info(f"Hash binary: {hash_bin} (exists: {os.path.exists(hash_bin)})")

		flatpak = Plugin._find_flatpak(self)
		if not flatpak:
			logger.info("flatpak: not found")
			return

		logger.info(f"flatpak binary: {flatpak}")
		deck_user = os.environ.get("SUDO_USER") or os.environ.get("USER") or "deck"

		try:
			installed = subprocess.run(
				["sudo", "-u", deck_user, flatpak, "list", "--app", "--columns=application"],
				capture_output=True, text=True
			).stdout.splitlines()
		except Exception as e:
			logger.debug(f"Could not list flatpaks: {e}")
			installed = []

		for flatpak_id in ["org.DolphinEmu.dolphin-emu", "io.github.shiiion.primehack"]:
			if flatpak_id not in installed:
				logger.info(f"Flatpak {flatpak_id}: not installed")
				continue
			try:
				result = subprocess.run(
					["sudo", "-u", deck_user, flatpak, "info", flatpak_id],
					capture_output=True, text=True
				)
				version_line = next((l for l in result.stdout.splitlines() if "Version:" in l), None)
				logger.info(f"Flatpak {flatpak_id}: {version_line.strip() if version_line else 'installed (version unknown)'}")
			except Exception as e:
				logger.debug(f"Could not get info for {flatpak_id}: {e}")

	# Asyncio-compatible long-running code, executed in a task when the plugin is loaded
	async def _main(self):
		await Plugin._log_tool_versions(self)
		if not os.path.exists(os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")):
			with open(os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "settings.json"), "w") as f:
				json.dump({
					"username": "",
					"api_key": "",
					"cache": {
						"ids": {}
					},
					"hidden": False
				}, f, indent="\t")

	async def _unload(self):
		pass

	async def _migration(self):
		decky_plugin.migrate_settings(
			os.path.join(decky_plugin.DECKY_HOME, "settings", "emuchievements.json"))
		if os.path.exists(os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "emuchievements.json")):
			os.rename(os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "emuchievements.json"),
					os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "settings.json"))
