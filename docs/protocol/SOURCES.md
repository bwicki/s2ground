# Sources used for `ssp-windsond-protocol.md` and `symbols.json`

Material: Windsond 3.8.0 (Sparv Embedded) — decompiled Python modules (pycdc output, partially
incomplete) plus the original Python 3.11 bytecode (constants / disassembly where the decompile
was incomplete), the shipped ontology text files and static files. Only file paths, class and
function names are listed here; no source text was copied into the deliverables.

| Spec section | Derived from (module → class/function) |
|---|---|
| 0 Big picture, 1.2 line classification | `sspobj/links/framing.py`: `HexOrBracketLineProtocol.on_line`, `HexLineProtocol.encode/on_line`, `hex_to_msg`, `BracketLineProtocol._parse_line/_on_done`, `MixedHexLineProtocol`; `windsond/dongle.py`: `SspObjDongle._on_receive`, `_is_local_response`, `_is_message` |
| 1.1 serial parameters | `windsond/dongle.py`: `SspObjDongle.__init__` (SerialDaemon baud 38400, LINE_ENDING); `windsond/s2_link.py`: `S2Link._on_sa1_link_change` (57600); `reactive/serialdaemon.py`: `SerialDaemon._open`, `LineReceiver`; `sspobj/links/serial.py`: `SerialLink.__init__` (library default 115200) |
| 1.3 text command protocol | `windsond/dongle.py`: `SspObjDongle._send_command`, `send_command`, `_on_timeout`, `_on_port_connected` (echo/mac/about sequence); `windsond/receiver_version.py`: `ReceiverVersion.from_string` and capability properties |
| 1.4 hex frame layout | `sspobj/links/framing.py`: `HexLineProtocol.encode`, `hex_to_msg`, `msg_to_bin`; `sspt/parse.py`: `parse_hex`; `sspt/bytebuffer.py`: `ByteIterator` (read/write primitives, varuint) |
| 1.5 addressing | `sspobj/net_constants.py`; `sspobj/network.py`: `Network.oid_to_link`, `is_local_object`, `_register_remote_component`, `_handle_link_newid`; `sspobj/remoteobject.py`: `RemoteAsyncObject.send_ssp_msg` |
| 1.6 timeouts/keep-alive | `sspobj/links/link.py`: `Link.__init__` (probeInterval), `_probe_or_ping`; `windsond/dongle.py`: `_net_timeout`, `_timer`, `_on_oid_change`, `_on_components`; `windsond/firmware.py`: `ReceiverData._on_timer`, `_on_bat`, `_on_temp` |
| 2.1 message codes and structs | `sspobj/messages.py` (module constants `SSPMESSAGE_*`, the `*_message_type` struct definitions, `message_type` union, `addressed_msg_type`) |
| 2.2 CInfo values | `sspobj/network.py`: `Network.get_our_cinfo`, `get_local_cinfo`, `Network.__init__` (serial, priority, preferred name); `sspt/constants.py` (`SSP_VERSION`, `SSP_MAGIC_BYTE`, `SSP_COMPATIBILITY`) |
| 2.3 error codes | `sspt/constants.py`: `COR_*`, `ERROR_CODES`, `SspException` |
| 2.4 example frames | generated with our own encoder `tools/sspbin.py` from the rules in sections 2–3 (synthetic) |
| 3 data types | `sspt/constants.py` (`SSP_TYPE_*`, `SSP_FORMAT_*`, null values); `sspt/pyObjects.py`: `to_impBin`, `to_expBin`, `from_expBin`, `from_schemaBin`, `from_pyValue`, `TypedMap*`, `Struct*`, `Tuple*`, `TypedList*`, `Fixpoint*`, `Scaled*`, `Union*`, `Symbol`, `String`, `Blob`, `define_builtins`; `sspt/bytebuffer.py` |
| 3.3 registry (REF) | `ontology/required.txt`, `builtin.txt`, `radio.txt`, `time.txt`, `central.txt`, `ssp.txt`, `positioning.txt`, `unsorted.txt`, `user.txt`, `logging.txt`, `hw_control.txt` (REF lines); parsed with `tools/parse_ontology.py` whose grammar follows `sspt/parse_ontology.py`: `parse_line` |
| 4 object model, symbol tables | ontology `SYM` lines (same files plus `device.txt`, `radiosonde.txt`, `temp_rh.txt`, `barometer.txt`, `sampling.txt`, `electric.txt`, `bootloader.txt`); usage evidence: `windsond/dongle.py`: `_on_components`, `_on_rr4_report`; `windsond/s2_link.py`: `S2Link.__init__` (`_vars` list), `_on_s2_report`, `_set_s2_source`, `_try_sync_net`; `windsond/connection_panel.py`: `S2SettingsPanel` (`_mode_status`, `_calibrate_s2`, `eph_upload_state`, `condition_iterator`, `txcriterion_ssp_nr_to_str`, `TXCRITERION_*`), `NetPanel._add_s2_fields`; `windsond/receiver_panel.py`: `EncryptionPanel._sync_s2`, `_upload_key`, `_on_connection_change` (utcSyncSource thresholds); `windsond/gnss_panel.py`: `GNSSPanel._get_gnssEnabled`, `_upload_to_remote`, `_do_subscribe/_do_unsubscribe`, `_validate_enabled`, `UbloxSatInfo`; `sspobj/remoteobject.py`: `RemoteAsyncObject.register_values` (Any fallback for radioEnabled/radioPaused/baroTemp) |
| 5.1 handshake | `windsond/dongle.py`: `_on_port_connected` (+ nested `echo_response`, `mac_response`, `about_response`, timeouts), `VERSION_RETRIES`; `windsond/receiver_version.py` |
| 5.2 join network | `sspobj/links/link.py`: `_probe_or_ping`, `on_networked`; `sspobj/network.py`: `_handle_link_newid` (+ `on_newid`), `_handle_cinfo`, `forget_network`, `lost_link`, `create_ticket` |
| 5.3 discovery | `windsond/dongle.py`: `_on_oid_change`, `_on_components`; `windsond/s2_link.py`: `_on_sa1net_oid_change`, `_set_s2_source`, `_on_subscribe_timeout`, `_on_receiver_s2_source_change`; `sspobj/remoteobject.py`: `get`, `get_var_types`, `subscribe`, `subscribe_ack`, `unsubscribe`, `set`, `call` and their reply handlers |
| 5.4 receiver settings | `windsond/firmware.py`: `SyncedTextFirmwareSetting` (`on_connection_change`, `_query_value`, `set_value`, `_on_get_response`, `_on_set_response`), `SyncedFreqSetting`, `SyncedTimeslotsSetting`, `SyncedSamplePeriodSetting`, `SyncedTimeslotMilliesSetting`, `SyncedMaxDataSetting`, `SyncedSspNetFirmwareSetting` (`_get`, `_set`, `_on_net_change`), `SyncedGroundSlotsFirmwareSetting`, `SyncedLora*FirmwareSetting`, `SONDE_TIMESLOTS` etc.; `windsond/net_settings.py`: `SyncedNetSettings`; `windsond/donglepanel.py`: `DonglePanel.on_find_button` (`annNet`), `assign_sond_id`, `_on_connection_change` (`rbeep`); `windsond/radio.py`: `PacketDispatcher._save_to_file/load_file` (sessions file) |
| 5.5 S2 settings | `windsond/connection_panel.py`: `NetPanel._add_s2_fields` (`txcriterion_onupdate`, `radio_pow_onupdate`), `S2SettingsPanel._calibrate_s2`; `windsond/gnss_panel.py` |
| 5.7 ephemeris | `windsond/s2_link.py`: `_download_ephemeris`, `_upload_ephemeris` (+ `chunked`), `check_eph_status`; `sparvio/assistnow.py`: `fetch` (parameters only — token not disclosed), `get_ubx_size`, `parse_parts`, `init` |
| 5.8 sonde text commands | `windsond/node.py`: `Node.execute_now`, `NodeWaitingForReplyState.on_message/_finalize_request/OnTimer`, `LocalNode`; `windsond/sond.py`: `_take_action_from_msg`, `_get_command_to_send_internal`, `get_command_to_send`, `get_relAP_cmd`, `_update_release_pressure`, `ground_pressure_set_cmd`; `windsond/parameter.py`: `ParameterSet.__init__` (parameter ids/set commands), `get_command_to_send`; `windsond/firmware.py`: `ReleaseBalloonAction`, `ReleaseGroundAction`, `BeepAction`, `PowerMwSetting`, `UpdaterateSetting`, `SupplyCalibrationSetting`, `Temp1BCalibration`, `Temp1R0Calibration`, `Autolog`, `GpsLog`, `*LogAction`; `windsond/sond_control_panel.py`: `WireTestPanel`, `SondControlPanel`; `windsond/radio.py`: `PacketDispatcher.get_or_make_sid` (`iparam`); `static/demo_2015-04-16_0656.sounding` (legacy command examples) |
| 5.9 arm/launch | `windsond/sond.py`: `_take_action_from_msg`, `_update_processed_data`; `windsond/radio.py`: `PacketDispatcher.on_message`, `get_or_make_id`, `get_or_make_id_sid`, `find_free_timeslot` |
| 5.10 bracket telemetry | `windsond/radio.py`: `Message` (type constants, `from_text`, `parse_coded_params`, `is_report`, `has_valid_gps`), `DongleStatusForwarder`; `windsond/sond.py`: `on_message`, `_insert_metdata`, `_handle_data_message`; `windsond/link.py`: `LinkStatistics.register`; `windsond/linktest.py`; `windsond/position.py`: `from_text`, `MinutePos.from_text`, `DecimalPos.from_text`; `windsond/sond_data_panel.py` (column keys, event names); `windsond/utils/sond.py`: `Capabilities` |
| 5.11 radio scan | `windsond/radio_scan.py`: `RadioScanner._send_step`, `_on_respone`, `rssi_hex_to_dbm`, `RadioScanPanel.__init__`; `windsond/receiver_version.py`: `has_freqscan` |
| 6.1 modes | `windsond/utils/sond.py`: `Modes`, `mode_map`, `get_status_text`; `windsond/parameter.py` (`md` options); `windsond/connection_panel.py`: `_mode_status`, `eph_upload_state` |
| 6.2 state machine | `windsond/sond.py`: `_update_processed_data`, `_find_radiosonde_launch_report`, `_find_dropsonde_drop_report`, `_find_lowest_wind_alt`, `_update_state`; `windsond/utils/sond.py`: `get_status_text` |
| 6.3 condition bitmap | `windsond/connection_panel.py`: `condition_iterator` |
| 6.5 thresholds | `windsond/sond_status_panel.py`: `SondStatusPanel` status evaluation |
| 7.1 .sounding | `windsond/log.py`: `Logger.write_header`, `write_line`, `log_comment`, `logger_iterator.__init__/__next__`, `remove_node_id`, `SOUNDING_VERSION`; `windsond/utils/str_timestamp.py`: `stringify`, `un_stringify`, `timestamp_to_string`; `windsond/utils/file_handling.py`: `make_filebase`; `windsond/radio.py`: `PacketDispatcher._make_filebase`, `_make_sond_logger`, `_save_to_file`, `load_file` |
| 7.2 raw_flight_history.csv | `windsond/formats/csv_formats.py`: `FlightHistoryCsvFormat` (`__init__`, `OnDataUpdated`, `on_new_data`), `HistoryCsvFormat`, `CsvFormat`, `MultiSondCsvFormat`, `MultiSondCsvFormat_UDP` |
| 7.3 template CSV | `windsond/formats/file_csv_format.py`: `FileCsvFormat.__init__/load_lines/write_header/on_new_data/generate_altitude`, parameter classes (labels); `static/fileformat_template.csv.txt`, `static/fileformat_sounding.csv.txt`; `windsond/correction_v2.py`/`correction_v3.py`: `describe` |
| 7.4 KML | `windsond/kml_export.py`: `KmlLineStringFile` templates, `timestamp_to_kml_string`; `windsond/log.py`: `KmlFile`; `windsond/formats/kml.py`: `KmlFormat` |
| feature history | `releasenotes.txt` |

Not used: `windsond/lic.py` (license check — PC only, not needed by the hardware; keys not reproduced), the AssistNow token in `sparvio/assistnow.py`.

## Revision 2 — Windsond 3.11.8 (2026-10-28)

Material: Windsond Desktop 3.11.8 — `releasenotes.txt` (3.8.1 … 3.11.8), decompiled modules (pycdc, partly
incomplete) and the Python 3.11 bytecode (constants / disassembly), compared constant-by-constant with the
3.8.0 bytecode. The ontology is now the Python package `ssp_ontology` (class bodies `SspSymbol`, `SspTypeId`,
`SspMessageId`, `SspErrorCode`, the dictionaries `SspSymIxToAscii` / `SspSymIxToData`, the `*Serializer`
classes). Still not used: `windsond/lic.py` (licence mechanism, only the *existence* of a licence-defined
frequency span is mentioned), the AssistNow token.

| Topic (CHANGES-3.11.8.md / spec section) | Derived from (module → class/function) |
|---|---|
| USB ids, baud table (§1.1) | `sspobj/links/serial.py`: `PortData`, `ALL_DEVICES`, `dynamic_baudrate`; `sparvio/rr4_wifi.py`: `main` (vidpid rules); `windsond/dongle.py`: `SspObjDongle.__init__` (38400) |
| `about` parsing (§5.1) | `windsond/receiver_version.py`: `ReceiverVersion.from_string` |
| CInfo compatibility, constants (§2.2) | `ssp_ontology/ssp.py` module constants (`SSP_COMPATIBILITY`, `SSP_WORKING_GET_VALUES`); `sspobj/network.py`: `Network.get_our_cinfo`, `Network.__init__` (default name) |
| message codes, registry 115–118, symbols (§2.1, §3.3, §4) | `ssp_ontology/ssp.py`: `SspMessageId`, `SspTypeId`, `SspSymbol`, `SspSymIxToAscii`, `SspSymIxToData`, `Int32Fix1000000Serializer`, `Uint64AndNameMapSerializer`, `Uint32AndStringSerializer`, `ListOfStringsSerializer` (`get_shape`) |
| `sspDefaultSet` auto-sync (§5.5a) | `windsond/dongle.py`: `RR4Obj`, `S2Obj`, `S2WithEncObj`, `SspConnection.__init__`, `_on_rr4_source_change` (+ `_success`), `_get_defaultset`, `_sync_s2`, `_set_net`, `_set_txCriterion`, `_set_power`, `_set_powerBeforeLaunch`, `_set_enc_key`, `_get_remote_var`, `_set_remote_var`; `windsond/receiver_version.py`: `LeaveUnchanged` |
| S2 role change | `windsond/connection_panel.py`: `S2SettingsPanel.__init__._set_role`, `sonde_roles`; `windsond/dongle.py`: `S2Obj` |
| cut-down via `mode=7`, `relGnd` check (§5.8) | `windsond/firmware.py`: `ReleaseBalloonAction.get_performcmd`, `ReleaseGroundAction.is_set_result_ok`; `windsond/firmware_fields.py`: `SmartAction.OnResponse` |
| behaviour after landing | `windsond/parameter.py`: `ParameterSet.__init__` (`behlan` options, `findme` set command) |
| radio quality decimals, `jam`/`spoof` (§5.10) | `windsond/radio.py`: `Message.from_text` (int/float key tuples); `windsond/sond.py`: `_find_spoofing_msgs`, `_check_for_gps_spoofing`, `get_gps_spoofing`, `update_role`, `is_role_dropsonde`; `windsond/utils/sond.py`: `get_status_text`, `get_packet_delay_ms`; `windsond/sond_status_panel.py`: `OnDataUpdated` |
| frequency limits (§5.4) | `windsond/dongle.py`: `SspObjDongle.get_frequency_span`, `__init__` (`allowed_freq_range`); `windsond/donglepanel.py`: dongle construction (default/extended span, field labels); `windsond/firmware.py`: `SyncedFreqSetting.to_value` (range check), `_to_machine_format` |
| ephemeris (§5.7) | `windsond/ephemeris_sync.py`: `EphemerisSync._download_ephemeris`, `_upload_ephemeris` (+ `chunked`), `check_eph_status`, `on_s2_source_change` |
| SA1 link removal | `windsond/dongle.py`: `enable_sa1_connection`, `_enable_sa1_connection`; `windsond/config.py`: `get_sa1_allowed` |
| WiFi settings (§1.8) | `sparvio/rr4_wifi.py`: `WiFiTypes`, `WifiSettingsDialog` (`_query_values`, `_add_pending`, `_on_ip` (+ `_callback`), `_on_apply`, `_on_get_success`, `_on_get_error`, `_update_status`, `_on_wifi_mode`, `_scan_wifi`), `main`; `windsond/connection_panel.py`: `NetPanel.__init__` ("WiFi Settings" button) |
| WebSocket SSP link (§1.8) | `sspobj/links/websocket.py`: `WebsocketDaemon` (`__init__`, `_connect`, `run`, `send`, `end_scope`), `WebsocketLink` (`__init__`, `on_message`, `_get_cinfo`, `on_connection_change`, `send_ssp_msg`); `sspobj/links/framing.py`: `msg_to_bin`, `hex_to_msg`; `sspobj/net_constants.py` |
| CSV units (§7.2) | `windsond/formats/csv_formats.py`: `FlightHistoryCsvFormat.__init__/on_new_data`, `HistoryCsvFormat`, `CsvFormat`, `MultiSondCsvFormat._get_intro`; `windsond/units.py`: `DistanceUnit_m/ft`, `SpeedUnit_*`, `TemperatureUnit_C/F/K` (`unit`); `static/fileformat_template.csv.txt` |
