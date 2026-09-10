import json
import logging
import math
import os
import sys
import subprocess
import decky_plugin
import xmltodict
import struct
import base64
import hashlib
import io
import shutil
from datetime import datetime, timezone, timedelta
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
TROPHY_STATE_ENTRY_HEADER_SIZE = 16
TROPHY_STATE_TABLE_TYPE = 6
TROPHY_STATE_ENTRY_CONTENTS_SIZE = 96
TROPHY_STATE_ENTRY_SIZE = TROPHY_STATE_ENTRY_HEADER_SIZE + TROPHY_STATE_ENTRY_CONTENTS_SIZE


GDFX_MAGIC = b"MICROSOFT*XBOX*MEDIA"
SECTOR_SIZE = 2048
BASE_SECTOR = 0x20

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

	async def python_version(self) -> str:
		return sys.version


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
	async def rpcs3_parse_trp_directory(self, trp_bytes: bytes) -> Dict[str, Tuple[int, int]]:
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
		result = {'trophies': []}

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
				trp = await Plugin.rpcs3_parse_trp_directory(self, trp_bytes)
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

		# Try retrieving in order: the requested language, English or default
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
				trp = await Plugin.rpcs3_parse_trp_directory(self, trp_bytes)
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
					raise ValueError("invalid trophy-state entry header: " + str(entry_index) + " -> " + str(entry_offset))

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

				parsed_states[str(trophy_id).zfill(3)] = {
					'unlocked': (trophy_state != 0),
					'unlock_time_utc': unlock_time_utc.timestamp() if not unlock_time_utc is None else None
				}

		if not table6_seen:
			raise ValueError("trophy-state table is missing")

		return json.dumps(parsed_states)


	async def xenia_check_user_path(self, user_path: str) -> bool:
		return os.path.isfile(user_path + "/Account")

	async def xenia_get_defaultxex(self, iso_path: str) -> bytes:
		with open(iso_path, "rb") as f:
			# https://github.com/xenia-manager/xenia-manager/blob/7704851bec096371e18d1394ed98f166469193db/source/XeniaManager.Core/Models/Files/Iso/IsoSectorReader.cs#L29
			header_offset = None
			base_sector = None
			root_sector = None
			root_size = None
			sectors = [
				BASE_SECTOR,	# XDKI
				0x30620, 		# XGD1
				0x4120,			# XGD3
				0x1FB40,		# XGD2
			]
			for sector in sectors:
				try:
					header_offset = sector * SECTOR_SIZE

					# Read root directory sector and size from GDFX header
					f.seek(header_offset)
					magic, root_sector, root_size = struct.unpack("<20sII", f.read(28))
					if magic == GDFX_MAGIC:
						base_sector = sector - BASE_SECTOR
						break

					f.seek(header_offset + SECTOR_SIZE - 20)
					tailMagic = struct.unpack("<20s", f.read(20))
					if tailMagic == GDFX_MAGIC:
						base_sector = sector - BASE_SECTOR
						break

					header_offset = None

				except:
					continue
			if header_offset is None:
				raise ValueError("Not a valid Xbox 360 GDFX ISO image.")

			# Parse directory entries looking for default.xex
			f.seek((base_sector + root_sector) * SECTOR_SIZE)
			dir_data = f.read(root_size)
			
			pos = 0
			while pos < len(dir_data):
				# Read entry header
				if pos + 14 > len(dir_data):
					break

				_, _, sector, size, _, name_len = struct.unpack("<HHIIBB", dir_data[pos:pos+14])
				if name_len == 0:
					break
					
				name = dir_data[pos+14 : pos+14+name_len].decode("ascii", errors="ignore")
				
				if name.lower() == "default.xex":
					f.seek((base_sector + sector) * SECTOR_SIZE)
					return f.read(size)
				
				# Entry size padded to 4-byte boundary
				entry_size = (14 + name_len + 3) & ~3
				pos += entry_size
		
		return None

	# headers_predicate receives (xex_bytes, key, value) and if returns not None it will be the returned result
	async def xenia_parse_xex(self, xex_bytes: bytes, headers_predicate):
		if len(xex_bytes) < 24 or xex_bytes[:4] != b"XEX2":
			raise ValueError("Not a valid XEX2 file.")

		# Read optional header count (Big-Endian)
		opt_header_count = struct.unpack(">I", xex_bytes[20:24])[0]
		
		pos = 24
		for _ in range(opt_header_count):
			if pos + 8 > len(xex_bytes):
				break
				
			key, value = struct.unpack(">II", xex_bytes[pos:pos+8])
			pos += 8

			result = headers_predicate(xex_bytes, key, value)
			if not result is None:
				return result
			
		return None

	async def xenia_get_titleid(self, iso_path: str) -> str:
		def titleid_filter(xex_bytes, key, value):
			# 0x00040006 = Execution ID, 06 x 4 = 24 bytes
			if key == 0x00040006:
				# Value stores the absolute offset to the execution info block
				# Title ID is located 12 bytes into Execution Info (4 bytes long)
				title_id_bytes = xex_bytes[value + 12 : value + 16]
				return title_id_bytes.hex().upper()
			else:
				return None

		xex_bytes = await Plugin.xenia_get_defaultxex(self, iso_path)
		if xex_bytes is None:
			return None
		return await Plugin.xenia_parse_xex(self, iso_path, titleid_filter)

	# entry_namespace:
	# 1 Metadata (check id = 1480672072 / XACH)
	# 2 Image
	# 3 String Tables (localization)
	async def xenia_get_spaxdbf(self, iso_path: str, title_id: str) -> bytes:
		xex_bytes = await Plugin.xenia_get_defaultxex(self, iso_path)
		if xex_bytes is None:
			return None

		# Save default.xex to a temporary file for xextool to read
		temp_xex_path = os.path.join("/tmp", f"{title_id}.xex")
		with open(temp_xex_path, "wb") as temp_xex_file:
			temp_xex_file.write(xex_bytes)
		
		# Run xextool with Wine
		temp_res_path = os.path.join("/tmp", f"{title_id}_spa")
		shutil.rmtree(temp_res_path, ignore_errors=True)
		cmd = [
			os.path.join(decky_plugin.HOME, ".local/share/Steam/steamapps/common/Proton - Experimental/files/bin/wine"),
			os.path.join(decky_plugin.DECKY_PLUGIN_DIR, "py_modules", "bin", "XexTool.exe"),
			"-d", temp_res_path,
			temp_xex_path
		]
		result = subprocess.run(cmd)

		# Remove default.xex
		os.remove(temp_xex_path)

		# Check if we have a file in the resource directory
		temp_spa_path = os.path.join(temp_res_path, title_id)
		if not os.path.isfile(temp_spa_path):
			shutil.rmtree(temp_res_path, ignore_errors=True)
			return None

		# Read the SPA file and return its bytes
		with open(temp_spa_path, "rb") as spa_file:
			spa_bytes = spa_file.read()
			shutil.rmtree(temp_res_path, ignore_errors=True)

			return spa_bytes

	# entry_predicate receives (xdbf_bytes, entry_namespace, entry_id, entry_offset, entry_size) and if returns not None it will be added to the returned result list
	# entry_offset: offset by start_pos
	async def xenia_parse_xdbf_all(self, xdbf_bytes: bytes, entry_predicate):
		if len(xdbf_bytes) < 4 or xdbf_bytes[:4] != b"XDBF":
			raise ValueError("Not a valid XDBF file.")
		
		entry_max, entry_current, free_max, free_current = struct.unpack(">IIII", xdbf_bytes[8:24])
		entries_offset = 24

		# https://free60.org/System-Software/Formats/XDBF/#entry-data-offset
		start_pos = (entry_max * 18) + (free_max * 8) + 24

		result_list = []

		for _ in range(entry_max):
			entry_namespace, entry_id, entry_offset, entry_size = struct.unpack(">HQII", xdbf_bytes[entries_offset:entries_offset+18])
			entries_offset += 18

			result = entry_predicate(xdbf_bytes, entry_namespace, entry_id, entry_offset + start_pos, entry_size)
			if not result is None:
				result_list.append(result)

		return result_list	

	async def xenia_parse_xdbf(self, xdbf_bytes: bytes, entry_predicate):
		result = await Plugin.xenia_parse_xdbf_all(self, xdbf_bytes, entry_predicate)
		if len(result) > 0:
			return result[0]
		else:
			return None

	# https://github.com/XboxChef/XeXtractor/blob/5fb6d8b17e5d38a6100590ce43962fb0df07770b/XDBF.cs#L126
	async def xenia_locale_to_xbox360(self, locale: str) -> int:
		match locale.lower():
			case "en": return 1
			case "ja": return 2
			case "de": return 3
			case "fr": return 4
			case "es": return 5
			case "it": return 6
			case "ko": return 7
			case "pt": return 9
			case "zh": return 10 # 8 is zh-TW
			case "pl": return 11
			case "ru": return 12

		return None

	async def xenia_get_localization(self, xdbf_bytes: bytes, locale: str) -> Dict[int, str]:
		def xstr_predicate(xdbf_bytes, ns, id, offset, size):
			if ns == 3 and id == xbox360_locale:
				return xdbf_bytes[offset:offset + size]
			else:
				return None

		xbox360_locale = await Plugin.xenia_locale_to_xbox360(self, locale)
		if xbox360_locale is None:
			return None

		localization = {}

		xstr_bytes = await Plugin.xenia_parse_xdbf(self, xdbf_bytes, xstr_predicate)
		if xstr_bytes is None or len(xstr_bytes) < 4 or xstr_bytes[:4] != b"XSTR":
			return None

		string_count = struct.unpack(">H", xstr_bytes[12:14])[0]
		string_offset = 14
		for _ in range(string_count):
			id, length = struct.unpack(">HH", xstr_bytes[string_offset:string_offset+4])
			localization[id] = xstr_bytes[string_offset+4:string_offset+4+length].decode("utf-8", errors="ignore")
			string_offset += 4 + length

		if len(localization) <= 0:
			return None
		else:
			return localization

	def xenia_parse_achievement_flags(self, flags: int):
		# Flags:
		# https://free60.org/System-Software/Formats/GPD/#flags
		# 0000 0000 000: Unknown
		# 0: Edited (1048576)
		# 00: Unknown
		# 0: Achievement earned (131072)
		# 0: Achievement earned online (65536)
		# 0000 0000 0000: Unknown
		# 0: Show unachieved (opposite of secret)
		# 000: Achievement type (1: Completion, 2: Leveling, 3: Unlock, 4: Event, 5: Tournament, 6: Checkpoint, 7: Other)
		achievement_type = None
		match (flags & 7):
			case 1:
				achievement_type = "Completion"
			case 2:
				achievement_type = "Leveling"
			case 3:
				achievement_type = "Unlock"
			case 4:
				achievement_type = "Event"
			case 5:
				achievement_type = "Tournament"
			case 6:
				achievement_type = "Checkpoint"
			case 7:
				achievement_type = "Other"

		return {
			'type': achievement_type,
			'secret': (flags & 8) == 0,
			'earned_online': (flags & 65536) != 0,
			'earned': (flags & 131072) != 0,
			'edited': (flags & 1048576) != 0
		}

	async def xenia_get_all_achievements_game(self, iso_path: str, title_id: str, locale: str) -> str:
		def xach_predicate(xdbf_bytes, ns, id, offset, size):
			if ns == 1 and id == 1480672072:
				return xdbf_bytes[offset:offset + size]
			else:
				return None

		def xstr_predicate(xdbf_bytes, ns, id, offset, size):
			if ns == 3 and id == xbox360_locale:
				return xdbf_bytes[offset:offset + size]
			else:
				return None

		result = {'achievements': []}

		xdbf_bytes = await Plugin.xenia_get_spaxdbf(self, iso_path, title_id)
		if xdbf_bytes is None:
			return json.dumps(result)

		# Retrieve achievements
		xach_bytes = await Plugin.xenia_parse_xdbf(self, xdbf_bytes, xach_predicate)
		if xach_bytes is None or len(xach_bytes) < 4 or xach_bytes[:4] != b"XACH":
			return json.dumps(result)

		# Retrieve localization, default to english
		localization_lang = await Plugin.xenia_get_localization(self, xdbf_bytes, locale)
		localization_en = None
		if locale.lower() != 'en':
			localization_en = await Plugin.xenia_get_localization(self, xdbf_bytes, 'en')
		
		if localization_lang is None and localization_en is None:
			return json.dumps(result)

		# Populate achievements
		achievement_count = struct.unpack(">H", xach_bytes[12:14])[0]
		achievement_offset = 14
		for _ in range(achievement_count):
			id, name_id, description_achieved_id, description_unachieved_id, icon_id, gamerscore, _, flags = struct.unpack(">HHHHIHHI", xach_bytes[achievement_offset:achievement_offset+20])
			achievement_offset += 36

			result['achievements'].append({
				'id': id,
				'name': localization_lang[name_id] if localization_lang and name_id in localization_lang else localization_en[name_id] if localization_en and name_id in localization_en else '',
				'description_achieved': localization_lang[description_achieved_id] if localization_lang and description_achieved_id in localization_lang else localization_en[description_achieved_id] if localization_en and description_achieved_id in localization_en else '',
				'description_unachieved': localization_lang[description_unachieved_id] if localization_lang and description_unachieved_id in localization_lang else localization_en[description_unachieved_id] if localization_en and description_unachieved_id in localization_en else '',
				'icon_id': icon_id,
				'gamerscore': gamerscore,
				'flags': Plugin.xenia_parse_achievement_flags(self, flags)
			})

		return json.dumps(result)

	async def xenia_get_achievement_icon_game(self, iso_path: str, title_id: str, icon_id: int) -> str:
		def icon_predicate(xdbf_bytes, ns, id, offset, size):
			if ns == 2 and id == icon_id:
				return xdbf_bytes[offset:offset + size]
			else:
				return None
		
		xdbf_bytes = await Plugin.xenia_get_spaxdbf(self, iso_path, title_id)
		if xdbf_bytes is None:
			return ''

		icon_bytes = await Plugin.xenia_parse_xdbf(self, xdbf_bytes, icon_predicate)
		if icon_bytes is None:
			return ''
		else:
			encoded_string = base64.b64encode(icon_bytes).decode('utf-8')
			return "data:image/png;base64," + encoded_string

	# entry_namespace:
	# 1 Achievement
	# 2 Image
	# 3 Setting
	# 4 Title
	# 5 String
	# 6 Achievement Security (created by GFWL for offline unlocked achievements?)
	#   Avatar Award (360 only, this is only stored with in the PEC)
	async def xenia_get_game_gpdxbdf(self, user_path: str, title_id: str) -> bytes:
		path = user_path + "/" + title_id + ".gpd"
		if not os.path.isfile(path):
			return None
		else:
			with open(path, "rb") as gpd_file:
				return gpd_file.read()

	# Also doubles as xenia_get_all_achievements_user(?)
	async def xenia_get_all_achievements_status(self, user_path: str, title_id: str) -> str:
		def achievements_predicate(xdbf_bytes, ns, id, offset, size):
			# https://github.com/justin-delano/PlayniteAchievements/blob/f778a5a6d673b9cb766bc83c0074f9d8bd0c1761/source/Providers/Xenia/GPDResolver.cs#L124-L127
			if ns == 1 and len(size >= 28):
				id, icon_id, gamerscore, flags, unlock_time = struct.unpack(">IIIIQ", xdbf_bytes[offset+4:offset+4+24])
				
				start = offset + 4 + 24
				end = start
				while xdbf_bytes[end:end+2] != b'\x00\x00' and end < offset + size:
					end += 2
				name = xdbf_bytes[start:end].decode('utf-8')

				start = end + 2
				end = start
				while xdbf_bytes[end:end+2] != b'\x00\x00' and end < offset + size:
					end += 2
				description_achieved = xdbf_bytes[start:end].decode('utf-8')

				start = end + 2
				end = start
				while xdbf_bytes[end:end+2] != b'\x00\x00' and end < offset + size:
					end += 2
				description_unachieved = xdbf_bytes[start:end].decode('utf-8')

				return {
					'id': id,
					'name': name,
					'description_achieved': description_achieved,
					'description_unachieved': description_unachieved,
					'icon_id': icon_id,
					'gamerscore': gamerscore,
					'flags': Plugin.xenia_parse_achievement_flags(self, flags),

					'unlock_time': unlock_time
				}
			else:
				return None
		
		parsed_states = {}
		
		xdbf_bytes = await Plugin.xenia_get_game_gpdxbdf(self, user_path, title_id)
		if xdbf_bytes is None:
			return json_dumps(parsed_states)

		# Retrieve achievements data
		achievements = await Plugin.xenia_parse_xdbf_all(self, xdbf_bytes, achievements_predicate)
		if len(achievements) > 0:
			for achievement in achievements:
				if 'id' in achievement:
					parsed_states[str(achievement['id'])] = achievement
		
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
