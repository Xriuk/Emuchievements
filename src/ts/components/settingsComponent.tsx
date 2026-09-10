import
{
	ChangeEvent,
	FC,
	useEffect,
	useRef,
	useState,
	VFC
} from "react";
import
{
	Field,
	Focusable,
	PanelSection, PanelSectionRow,
	SidebarNavigation,
	TextField,
	ToggleField,
	Navigation,
	Dropdown,
	ButtonItem,
	DialogBody,
	DialogControlsSection,
	Toggle,
} from "@decky/ui";
import { useEmuchievementsState } from "../hooks/achievementsContext";
import { FileSelectionType, openFilePicker, toaster } from "@decky/api";
import { ReactMarkdown, ReactMarkdownOptions } from "react-markdown/lib/react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslations } from "../useTranslations";
import { StyledButtonItem } from "./styleWrapper";
import { RPCS3_USER_PATH_DEFAULT } from "../settings";

interface MarkdownProps extends ReactMarkdownOptions
{
	onDismiss?: () => void;
}

const Markdown: FC<MarkdownProps> = (props) =>
{
	return (
		<Focusable>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					div: (nodeProps) => <Focusable {...nodeProps.node.properties}>{nodeProps.children}</Focusable>,
					a: (nodeProps) =>
					{
						const aRef = useRef<HTMLAnchorElement>(null);
						return (
							// TODO fix focus ring
							<Focusable
								onActivate={() => { }}
								onOKButton={() =>
								{
									props.onDismiss?.();
									Navigation.NavigateToExternalWeb(aRef.current!.href);
								}}
								style={{ display: 'inline' }}
							>
								<a ref={aRef} {...nodeProps.node.properties}>
									{nodeProps.children}
								</a>
							</Focusable>
						);
					},
				}}
				{...props}
			>{props.children}</ReactMarkdown>
		</Focusable>
	);
};

const GeneralSettings: VFC = () =>
{
	const t = useTranslations();
	const { settings } = useEmuchievementsState();
	return <DialogBody>
		<DialogControlsSection>
			<Field label={t('settingsGamePage')}>
				<Toggle
					value={settings.general.game_page}
					onChange={async (checked) => {
						settings.general.game_page = checked;
						await settings.writeSettings();
					}}
				/>
			</Field>
			<Field label={t('settingsStoreCategory')}>
				<Toggle
					value={settings.general.store_category}
					onChange={async (checked) => {
						settings.general.store_category = checked;
						await settings.writeSettings();
					}}
				/>
			</Field>
		</DialogControlsSection>
	</DialogBody>;
};

const RetroAchievementsSettings: VFC = () =>
{
	const t = useTranslations();
	const { loadingData, login, settings } = useEmuchievementsState();
	const [loginData , setLoginData] = useState({
		username: '',
		api_key: '',
	});

	const onInputChange = (event: ChangeEvent<HTMLInputElement>, inputName: 'username' | 'api_key') => {
		setLoginData((value) => ({
			...value,
			[inputName]: event.target.value,
		}));
	}

	useEffect(() => {
		setLoginData({
			username: settings.retroachievements.username,
			api_key: settings.retroachievements.api_key
		})
	}, [settings.retroachievements.username, settings.retroachievements.api_key]);

	type TableRowsProps = {
		appId: string | undefined | null;
		retroAchievementAppId: string | undefined;
	}

	const [tableRows, setTableRows] = useState<TableRowsProps[]>([])
	const emuchievementsState = useEmuchievementsState();
	const onChangeRetroAchievementsId = (index: number, appId: string) => {
		const newRows = [...tableRows]
		newRows[index].retroAchievementAppId = appId;

		setTableRows(newRows);
	}

	const onGameChange = (index: number, appId: string) => {
		const newRows = [...tableRows];
		newRows[index].appId = appId;

		setTableRows(newRows);
	}

	const { custom_ids_overrides }= emuchievementsState.settings.data.cache;
	const gameOptions = Object.keys(custom_ids_overrides)
		.map((item) => {
			const idAsNumber = Number.parseInt(item, 10);
			const currentApp = custom_ids_overrides[idAsNumber];

			return {
				data: item,
				appId: item,
				retroAchievementAppId: currentApp.retro_achivement_game_id,
				label: currentApp.name ?? item,
			}
		}).sort((a, b) => a.label.localeCompare(b.label));

	useEffect(() => {
		setTableRows([
			...gameOptions
				.filter((option) => option.retroAchievementAppId)
				.map((item) => ({
					appId: `${item.appId}`,
					retroAchievementAppId: `${item.retroAchievementAppId}`
				})),
			{
				appId: undefined,
				retroAchievementAppId: undefined,
			},
		])
	}, [])

	const save = async () => {
		const appsToAdd = tableRows.filter((row) => row.appId);

		for (const app of appsToAdd) {
			const { appId, retroAchievementAppId } = app;

			if (!appId) {
				continue
			}

			const appIdAsNumber = Number.parseInt(appId, 10);

			if (!retroAchievementAppId) {
				emuchievementsState.settings.data.cache.custom_ids_overrides[appIdAsNumber] = {
					...emuchievementsState.settings.data.cache.custom_ids_overrides[appIdAsNumber],
					retro_achivement_game_id: null,
					hash: null,
				}

				continue;
			}

			const retroAchievementAppIdAsNumber = Number.parseInt(retroAchievementAppId, 10);

			if (Number.isNaN(retroAchievementAppIdAsNumber) || retroAchievementAppIdAsNumber <= 0) {
				emuchievementsState.settings.data.cache.custom_ids_overrides[appIdAsNumber] = {
					...emuchievementsState.settings.data.cache.custom_ids_overrides[appIdAsNumber],
					retro_achivement_game_id: null,
					hash: null,
				}

				continue
			}

			emuchievementsState.settings.data.cache.custom_ids_overrides[appIdAsNumber] = {
				...emuchievementsState.settings.data.cache.custom_ids_overrides[appIdAsNumber],
				retro_achivement_game_id: Number.parseInt(retroAchievementAppId),
			};
		}

		await emuchievementsState.settings.writeSettings();
	}

	const addRow = () => {
		setTableRows([...tableRows, {
			appId: undefined,
			retroAchievementAppId: undefined,
		}]);
	}

	return (<div style={{
		marginTop: '40px',
		height: 'calc( 100% - 40px )',
	}}>
		<PanelSection title={t("settingsRetroAchievements")}>
			<PanelSectionRow>
				<div className="DialogInputLabelGroup">
					<ToggleField
						label={t("settingsEnabled")}
						checked={(settings.retroachievements.enabled ?? true)}
						onChange={async (checked) => {
							settings.retroachievements.enabled = checked;
							await settings.writeSettings();
						}}/>
				</div>
			</PanelSectionRow>

			<PanelSectionRow>
				<Field label={t("settingsInstructions")}>
					<Markdown>
						{t("settingsInstructionsMD")}
					</Markdown>
				</Field>
			</PanelSectionRow>

			<PanelSectionRow>
				<TextField
					label={t("settingsUsername")}
					value={loginData.username}
					disabled={loadingData.globalLoading}
					onChange={(event) => onInputChange(event, 'username')}
				/>
			</PanelSectionRow>

			<PanelSectionRow>
				<TextField
					label={t("settingsAPIKey")}
					value={loginData.api_key}
					bIsPassword={true}
					disabled={loadingData.globalLoading}
					onChange={(event) => onInputChange(event, 'api_key')}
				/>
			</PanelSectionRow>

			<PanelSectionRow>
				<StyledButtonItem disabled={loadingData.globalLoading} onClick={
					async () =>
					{
						const { username, api_key } = loginData;

						const result = await login({
							username,
							api_key,
						});

						toaster.toast({
							title: t("title"),
							body: result ? t("loginSuccess") : t("loginFailed")
						});
					}}>
					{t("login")}
				</StyledButtonItem>
			</PanelSectionRow>
		</PanelSection>

		<PanelSection title={t("settingsCustomIdsOverrides")}>
			<ButtonItem layout="below" onClick={() => save()}>
				{ t('settingsCustomIdsOverridesSave')}
			</ButtonItem>

			<div style={{overflow: 'scroll',height: '100%',}}>
				<div
					className="header-row"
					style={{ gridTemplateColumns: '75% 25%', display: 'grid'}}
				>
					<div style={{padding: '10px 10px',textAlign: 'center',fontWeight: 600}}>
						Game
					</div>

					<div style={{padding: '10px 10px',textAlign: 'center',fontWeight: 600}}>
						RA Id
					</div>
				</div>
			</div>

			{tableRows.map((row, idx) => (
				<Focusable
					key={row.appId}
					flow-children="horizontal"
					style={{
						gridTemplateColumns: '75% 25%',
						padding: '10px 10px 10px 0px',textAlign: 'center',display: 'grid',
					}}
				>
					<Dropdown
						rgOptions={gameOptions}
						selectedOption={row.appId}
						onChange={(e) => onGameChange(idx, e.data)}
					/>

					<TextField
						style={{ marginLeft: '1rem'}}
						mustBeNumeric
						defaultValue={row.retroAchievementAppId}
						onChange={(e) =>
							onChangeRetroAchievementsId(idx, e.target.value)
						}
					/>
				</Focusable>
			))}

			<ButtonItem layout="below" onClick={() => addRow()}>
				{ t('settingsCustomIdsOverridesAddRow')}
			</ButtonItem>
		</PanelSection>
	</div>);
};

const RPCS3Settings: VFC = () => {
	const t = useTranslations();
	const { loadingData, settings } = useEmuchievementsState();

	const [rpcs3Data , setRpcs3Data] = useState({
		path: '',
		locale: '',
		npsso: ''
	});

	useEffect(() => {
		setRpcs3Data({
			path: settings.rpcs3.user_path ?? RPCS3_USER_PATH_DEFAULT,
			locale: settings.rpcs3.locale ?? 'en',
			npsso: settings.rpcs3.npsso ?? ''
		})
	}, [settings.rpcs3.user_path, settings.rpcs3.locale, settings.rpcs3.npsso]);

	return (
		<div style={{
			marginTop: '40px',
			height: 'calc(100% - 40px)',
		}}>
			<PanelSection title={t("settingsRPCS3")}>
				<PanelSectionRow>
					<div className="DialogInputLabelGroup">
						<ToggleField
							label={t("settingsEnabled")}
							checked={(settings.rpcs3.enabled ?? true)}
							onChange={async (checked) => {
								settings.rpcs3.enabled = checked;
								await settings.writeSettings();
							}}/>
					</div>
				</PanelSectionRow>
				
				<PanelSectionRow>
					<TextField
						label={t("rpcs3UserPath")}
						description={t("rpcs3UserPathDescription")}
						value={rpcs3Data.path}
						disabled={loadingData.globalLoading}
						onChange={async (event) => {
							setRpcs3Data(value => ({
								...value,
								path: event.target.value
							}));
							settings.rpcs3.user_path = event.target.value;
							await settings.writeSettings();
						}}/>
				</PanelSectionRow>

				<PanelSectionRow>
					<div className="DialogInputLabelGroup">
						<StyledButtonItem disabled={loadingData.globalLoading} onClick={
							async () =>
							{
								let result = await openFilePicker(FileSelectionType.FOLDER, rpcs3Data.path && rpcs3Data.path != RPCS3_USER_PATH_DEFAULT ? rpcs3Data.path : '/home', true, true, undefined, undefined, true, true);
								let path = result.path ?? '';
								setRpcs3Data(value => ({
									...value,
									path: path
								}));
								settings.rpcs3.user_path = path;
								await settings.writeSettings();
							}}>
							{t("browse")}
						</StyledButtonItem>
					</div>
				</PanelSectionRow>

				<PanelSectionRow>
					<TextField
						label={t("rpcs3Locale")}
						description={t("rpcs3LocaleDescription")}
						value={rpcs3Data.locale}
						disabled={loadingData.globalLoading}
						onChange={async (event) => {
							setRpcs3Data(value => ({
								...value,
								locale: event.target.value
							}));
							settings.rpcs3.locale = event.target.value;
							await settings.writeSettings();
						}}/>
				</PanelSectionRow>

				<PanelSectionRow>
					<div className="DialogInputLabelGroup">
						<ToggleField
							label={t("rpcs3TrophiesCatPrefixes")}
							description={t("rpcs3TrophiesCatPrefixesDescription")}
							checked={(settings.rpcs3.show_cat_prefixes ?? true)}
							onChange={async (checked) => {
								settings.rpcs3.show_cat_prefixes = checked;
								await settings.writeSettings();
							}}/>
					</div>
				</PanelSectionRow>

				<PanelSectionRow>
					<Field label={t("settingsInstructions")}>
						<Markdown>
							{t("rpcs3SettingsInstructionsMD")}
						</Markdown>
					</Field>
				</PanelSectionRow>

				<PanelSectionRow>
					<TextField
						label={t("rpcs3PSNAPIToken")}
						value={rpcs3Data.npsso}
						disabled={loadingData.globalLoading}
						onChange={async (event) => {
							setRpcs3Data(value => ({
								...value,
								npsso: event.target.value
							}));
							settings.rpcs3.npsso = event.target.value;
							await settings.writeSettings();
						}}/>
				</PanelSectionRow>
			</PanelSection>
		</div>
	);
};

const XeniaSettings: VFC = () => {
	const t = useTranslations();
	const { loadingData, settings } = useEmuchievementsState();

	const [xeniaData , setXeniaData] = useState({
		path: '',
		locale: ''
	});

	useEffect(() => {
		setXeniaData({
			path: settings.xenia.user_path ?? '',
			locale: settings.xenia.locale ?? 'en'
		})
	}, [settings.xenia.user_path, settings.xenia.locale]);

	return (
		<div style={{
			marginTop: '40px',
			height: 'calc(100% - 40px)',
		}}>
			<PanelSection title={t("settingsXenia")}>
				<PanelSectionRow>
					<div className="DialogInputLabelGroup">
						<ToggleField
							label={t("settingsEnabled")}
							checked={(settings.xenia.enabled ?? true)}
							onChange={async (checked) => {
								settings.xenia.enabled = checked;
								await settings.writeSettings();
							}}/>
					</div>
				</PanelSectionRow>
				
				<PanelSectionRow>
					<TextField
						label={t("rpcs3UserPath")}
						description={t("xeniaUserPathDescription")}
						value={xeniaData.path}
						disabled={loadingData.globalLoading}
						onChange={async (event) => {
							setXeniaData(value => ({
								...value,
								path: event.target.value
							}));
							settings.xenia.user_path = event.target.value;
							await settings.writeSettings();
						}}/>
				</PanelSectionRow>

				<PanelSectionRow>
					<div className="DialogInputLabelGroup">
						<StyledButtonItem disabled={loadingData.globalLoading} onClick={
							async () =>
							{
								let result = await openFilePicker(FileSelectionType.FOLDER, xeniaData.path || '/home', true, true, undefined, undefined, true, true);
								let path = result.path ?? '';
								setXeniaData(value => ({
									...value,
									path: path
								}));
								settings.xenia.user_path = path;
								await settings.writeSettings();
							}}>
							{t("browse")}
						</StyledButtonItem>
					</div>
				</PanelSectionRow>

				<PanelSectionRow>
					<TextField
						label={t("xeniaLocale")}
						description={t("xeniaLocaleDescription")}
						value={xeniaData.locale}
						disabled={loadingData.globalLoading}
						onChange={async (event) => {
							setXeniaData(value => ({
								...value,
								locale: event.target.value
							}));
							settings.xenia.locale = event.target.value;
							await settings.writeSettings();
						}}/>
				</PanelSectionRow>

				<PanelSectionRow>
					<div className="DialogInputLabelGroup">
						<ToggleField
							label={t("xeniaShowGamerscore")}
							description={t("xeniaShowGamerscoreDescription")}
							checked={(settings.xenia.show_gamerscore ?? true)}
							onChange={async (checked) => {
								settings.xenia.show_gamerscore = checked;
								await settings.writeSettings();
							}}/>
					</div>
				</PanelSectionRow>

				<Field
					label={t('xeniaDescription')}
					description={t('xeniaDescriptionDescription')}
					childrenContainerWidth={'fixed'}>
					<Dropdown
						rgOptions={[
							{ data: undefined, label: t("xeniaDescriptionBoth") },
							{ data: true, label: t("xeniaDescriptionLocked") },
							{ data: false, label: t("xeniaDescriptionUnlocked") },
						]}
						selectedOption={settings.xenia.show_description_locked}
						onChange={async (newVal) => {
							settings.xenia.show_description_locked = newVal.data;
							await settings.writeSettings();
						}}
					/>
				</Field>
			</PanelSection>
		</div>
	);
};

export const SettingsComponent: VFC = () =>
{
	const t = useTranslations();
	return <SidebarNavigation title={t("settingsTitle")} showTitle pages={[
		{
			title: t("settingsGeneral"),
			content: <GeneralSettings />,
		},
		{
			title: t("settingsRetroAchievements"),
			content: <RetroAchievementsSettings />,
		},
		{
			title: t("settingsRPCS3"),
			content: <RPCS3Settings />,
		},
		{
			title: t("settingsXenia"),
			content: <XeniaSettings />,
		}
	]} />;
};
