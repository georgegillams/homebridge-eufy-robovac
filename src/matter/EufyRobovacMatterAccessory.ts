import type { API, Logging, MatterRequests, PlatformConfig } from 'homebridge';

import { MatterStatus } from 'homebridge';

import { BaseMatterAccessory } from './BaseMatterAccessory.js';
import {
  mapEufyErrorToMatterErrorState,
  getEufyErrorDescription,
  getMatterErrorStateName,
  MatterErrorState,
} from './errorMapping.js';

interface RobovacEvent {
  command: string;
  value: boolean | number | string | object | null;
}

interface ConsumableAlert {
  consumable: string;
  duration: number;
}

interface RoomSwitch {
  name: string;
  rooms: string;
}

// Operational state constants
const OP_STOPPED = 0;
const OP_RUNNING = 1;
const OP_PAUSED = 2;
const OP_ERROR = 3;
const OP_SEEKING_CHARGER = 64;
const OP_CHARGING = 65;
const OP_DOCKED = 66;

// Run mode constants
const RUN_IDLE = 0;
const RUN_CLEANING = 1;

// Clean speed mode constants
const CLEAN_SPEED_QUIET = 0;
const CLEAN_SPEED_STANDARD = 1;
const CLEAN_SPEED_TURBO = 2;
const CLEAN_SPEED_MAX = 3;

// Identify type: 3 = AudibleBeep (plays a sound to locate the device)
const IDENTIFY_TYPE_AUDIBLE_BEEP = 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RoboVac = any;

// DPS keys that affect Running / Paused / Docked / SeekingCharger mapping.
const OPERATIONAL_DPS_KEYS = ['2', '15', '101', '122', '142', '151', '152', '153', '173'];

// Default poll interval: Eufy app (cloud) changes often do not push over local Tuya.
const DEFAULT_STATE_REFRESH_SECONDS = 15;

export class EufyRobovacMatterAccessory extends BaseMatterAccessory {
  private currentOperationalState: number;
  private selectedAreaIds: number[];
  private currentCleanSpeed: number;
  private currentErrorState: number;
  private readonly roomMap: Array<{ name: string; rooms: number[] }>;
  private readonly robovac: RoboVac;
  private readonly stateRefreshIntervalMs: number;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lastEufyStateSignature = '';

  constructor(api: API, log: Logging, config: PlatformConfig, robovac: RoboVac) {
    const serialNumber = config.deviceId as string;
    const roomSwitches: RoomSwitch[] = config.roomSwitches ?? [];
    const roomMap = roomSwitches.map((rs: RoomSwitch) => ({
      name: rs.name,
      rooms: rs.rooms.split(',').map(Number),
    }));

    const hasServiceArea = roomMap.length > 0;
    const allAreaIds = roomMap.map((_r, i) => i);

    super(api, log, {
      UUID: api.matter!.uuid.generate(`${config.name}-${config.ip}`),
      displayName: `${config.name}`,
      deviceType: api.matter!.deviceTypes.RoboticVacuumCleaner,
      serialNumber,
      manufacturer: 'Eufy',
      model: 'RoboVac',
      firmwareRevision: '1.0.0',
      hardwareRevision: '1.0.0',

      clusters: {
        identify: {
          identifyTime: 0,
          identifyType: IDENTIFY_TYPE_AUDIBLE_BEEP,
        },

        powerSource: {
          status: 0,
          order: 0,
          description: 'Battery',
          batPercentRemaining: EufyRobovacMatterAccessory.batteryPercentRemaining(
            EufyRobovacMatterAccessory.safeBatteryLevel(robovac),
          ),
          batChargeLevel: EufyRobovacMatterAccessory.computeChargeLevel(
            EufyRobovacMatterAccessory.safeBatteryLevel(robovac) ?? 100,
          ),
          batReplaceability: 1,
          batChargeState: EufyRobovacMatterAccessory.computeChargeState(robovac),
        },

        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: RUN_IDLE, modeTags: [{ value: 16384 }] },
            { label: 'Cleaning', mode: RUN_CLEANING, modeTags: [{ value: 16385 }] },
          ],
          currentMode: RUN_IDLE,
        },

        rvcCleanMode: {
          supportedModes: [
            { label: 'Quiet', mode: CLEAN_SPEED_QUIET, modeTags: [{ value: 2 }, { value: 16385 }] },
            { label: 'Standard', mode: CLEAN_SPEED_STANDARD, modeTags: [{ value: 16385 }] },
            { label: 'Turbo', mode: CLEAN_SPEED_TURBO, modeTags: [{ value: 1 }, { value: 16385 }] },
            { label: 'Max', mode: CLEAN_SPEED_MAX, modeTags: [{ value: 16384 }, { value: 16385 }] },
          ],
          currentMode: CLEAN_SPEED_STANDARD,
        },

        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: OP_STOPPED },
            { operationalStateId: OP_RUNNING },
            { operationalStateId: OP_PAUSED },
            { operationalStateId: OP_ERROR },
            { operationalStateId: OP_SEEKING_CHARGER },
            { operationalStateId: OP_CHARGING },
            { operationalStateId: OP_DOCKED },
          ],
          operationalState: OP_DOCKED,
        },

        ...(hasServiceArea ? {
          serviceArea: {
            supportedMaps: [
              { mapId: 0, name: 'Home' },
            ],
            supportedAreas: roomMap.map((room, index) => ({
              areaId: index,
              mapId: 0,
              areaInfo: {
                locationInfo: {
                  locationName: room.name,
                  floorNumber: 0,
                  areaType: null,
                },
                landmarkInfo: null,
              },
            })),
            selectedAreas: [...allAreaIds],
          },
        } : {}),
      },

      handlers: {
        identify: {
          identify: async (request: MatterRequests.IdentifyRequest) => this.handleIdentify(request),
        },
        rvcRunMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) => this.handleChangeRunMode(request),
        },
        rvcCleanMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) => {
            this.logInfo(`clean mode change requested: ${request.newMode}`);
            this.ensureConnected();
            const { newMode } = request;

            try {
              switch (newMode) {
              case CLEAN_SPEED_QUIET:
                this.logDebug('setting clean speed to Quiet');
                await this.robovac.setCleanSpeedQuiet();
                break;
              case CLEAN_SPEED_STANDARD:
                this.logDebug('setting clean speed to Standard');
                await this.robovac.setCleanSpeedStandard();
                break;
              case CLEAN_SPEED_TURBO:
                this.logDebug('setting clean speed to Turbo');
                await this.robovac.setCleanSpeedTurbo();
                break;
              case CLEAN_SPEED_MAX:
                this.logDebug('setting clean speed to Max');
                await this.robovac.setCleanSpeedMax();
                break;
              default:
                this.logWarn(`unknown clean speed mode: ${newMode}`);
              }
              this.currentCleanSpeed = newMode;
              await this.updateCleanMode(newMode);
            } catch (error: unknown) {
              this.logError('Failed to set clean speed:', error);
              throw error;
            }
          },
        },
        rvcOperationalState: {
          pause: async () => this.handlePause(),
          resume: async () => this.handleResume(),
          goHome: async () => this.handleGoHome(),
        },
        ...(hasServiceArea ? {
          serviceArea: {
            selectAreas: async (request: MatterRequests.SelectAreas) => this.handleSelectAreas(request),
            skipArea: async (request: MatterRequests.SkipArea) => this.handleSkipArea(request),
          },
        } : {}),
      },
    });

    this.robovac = robovac;
    this.roomMap = roomMap;
    this.selectedAreaIds = [...allAreaIds];
    this.currentOperationalState = OP_DOCKED;
    this.currentCleanSpeed = CLEAN_SPEED_STANDARD;
    this.currentErrorState = 0; // NoError

    const refreshSeconds = typeof config.stateRefreshInterval === 'number'
      ? config.stateRefreshInterval
      : DEFAULT_STATE_REFRESH_SECONDS;
    this.stateRefreshIntervalMs = Math.max(0, refreshSeconds) * 1000;

    this.setupEventListeners();
    this.logInfo('initialized and ready.');
  }

  // ─── Handlers ──────────────────────────────────────────────────────

  private async handleIdentify(request: MatterRequests.IdentifyRequest): Promise<void> {
    this.logInfo(`identify requested (identifyTime=${request.identifyTime}s) — playing sound to locate`);
    this.ensureConnected();
    try {
      await this.robovac.locate(true);
    } catch (error: unknown) {
      this.logError('Failed to locate RoboVac:', error);
      throw error;
    }
  }

  private async handleChangeRunMode(request: MatterRequests.ChangeToMode): Promise<void> {
    this.logInfo(`run mode change requested: ${request.newMode === RUN_IDLE ? 'Idle' : 'Cleaning'} (${request.newMode})`);
    this.ensureConnected();
    const { newMode } = request;

    if (newMode === RUN_CLEANING) {
      if (this.selectedAreaIds.length > 0 && this.roomMap.length > 0) {
        const rooms = this.selectedAreaIds.flatMap(id => this.roomMap[id]?.rooms ?? []);
        this.logDebug(`cleaning rooms: ${rooms.join(', ')}`);
        await this.robovac.cleanRooms(rooms);
      } else {
        this.logDebug('starting full clean');
        await this.robovac.clean();
      }
      await this.updateOperationalState(OP_RUNNING);
    } else if (newMode === RUN_IDLE) {
      this.logDebug('pausing and returning to dock');
      await this.robovac.pause();
      if (this.supportsHome()) {
        await this.robovac.goHome(true);
        await this.updateOperationalState(OP_SEEKING_CHARGER);
      } else {
        await this.updateOperationalState(OP_STOPPED);
      }
    }
  }

  private async handlePause(): Promise<void> {
    this.logInfo('pause requested');
    this.ensureConnected();
    const invalidStates = [OP_CHARGING, OP_DOCKED, OP_STOPPED];
    if (invalidStates.includes(this.currentOperationalState)) {
      this.logWarn(`cannot pause in state ${this.currentOperationalState}`);
      throw new MatterStatus.InvalidInState(
        `Cannot pause while in state ${this.currentOperationalState}`,
      );
    }

    // Devices with DPS 122 use workStatus2=Pause (playPause stays true). Classic models
    // clear playPause. RoboVac.pause() picks the right command.
    const via122 = typeof this.robovac.supportsWorkStatus2Pause === 'function'
      && this.robovac.supportsWorkStatus2Pause();
    this.logInfo(via122 ? 'pause via DPS 122=Pause' : 'pause via playPause=false');
    await this.robovac.pause();
    if (via122) {
      // Optimistically mirror what the Eufy app reports; dp-refresh confirms shortly after.
      this.robovac.dps = { ...this.robovac.dps, '122': 'Pause' };
    }
    await this.updateOperationalState(OP_PAUSED);
  }

  private async handleResume(): Promise<void> {
    this.logInfo('resume requested');
    this.ensureConnected();
    const invalidStates = [OP_SEEKING_CHARGER, OP_CHARGING, OP_DOCKED, OP_STOPPED];
    if (invalidStates.includes(this.currentOperationalState)) {
      this.logWarn(`cannot resume in state ${this.currentOperationalState}`);
      throw new MatterStatus.InvalidInState(
        `Cannot resume while in state ${this.currentOperationalState}`,
      );
    }

    // If the device already ended the job (standby), resume() times out — start a new clean.
    const activity = EufyRobovacMatterAccessory.safeActivity(this.robovac);
    if (EufyRobovacMatterAccessory.isStandbyActivity(activity)) {
      this.logInfo('resume while standby — starting a new clean (job was ended, not paused)');
      await this.robovac.clean();
    } else {
      const via122 = typeof this.robovac.supportsWorkStatus2Pause === 'function'
        && this.robovac.supportsWorkStatus2Pause();
      this.logInfo(via122 ? 'resume via DPS 122=Continue' : 'resume via playPause=true');
      await this.robovac.resume();
      if (via122) {
        this.robovac.dps = { ...this.robovac.dps, '122': 'Continue' };
      }
    }
    await this.updateRunMode(RUN_CLEANING);
    await this.updateOperationalState(OP_RUNNING);
  }

  private async handleGoHome(): Promise<void> {
    this.logInfo('go home requested');
    this.ensureConnected();
    if (this.currentOperationalState === OP_DOCKED || this.currentOperationalState === OP_CHARGING) {
      this.logWarn('go home requested but already docked/charging');
      throw new MatterStatus.InvalidInState('Already docked');
    }

    await this.robovac.pause();
    await this.robovac.goHome(true);
    await this.updateRunMode(RUN_IDLE);
    await this.updateOperationalState(OP_SEEKING_CHARGER);
  }

  private async handleSelectAreas(request: MatterRequests.SelectAreas): Promise<void> {
    this.logInfo(`select areas requested: [${request.newAreas.join(', ')}]`);
    const { newAreas } = request;

    for (const areaId of newAreas) {
      if (areaId < 0 || areaId >= this.roomMap.length) {
        this.logWarn(`area ID ${areaId} not found`);
        throw new MatterStatus.NotFound(`Area ID ${areaId} not found`);
      }
    }

    this.selectedAreaIds = newAreas.length > 0 ? [...newAreas] : this.roomMap.map((_r, i) => i);
    await this.updateState('serviceArea', { selectedAreas: [...this.selectedAreaIds] });
    const areaNames = this.selectedAreaIds.map(id => this.roomMap[id]?.name ?? `Area ${id}`);
    this.logInfo(`selected areas: ${areaNames.join(', ')}`);
  }

  private async handleSkipArea(request: MatterRequests.SkipArea): Promise<void> {
    this.logInfo(`skip area requested: ${request.skippedArea}`);
    const { skippedArea } = request;

    if (skippedArea < 0 || skippedArea >= this.roomMap.length) {
      this.logWarn(`area ID ${skippedArea} not found`);
      throw new MatterStatus.NotFound(`Area ID ${skippedArea} not found`);
    }

    this.selectedAreaIds = this.selectedAreaIds.filter(id => id !== skippedArea);
    await this.updateState('serviceArea', { selectedAreas: [...this.selectedAreaIds] });
    this.logInfo(`skipped area ${skippedArea}, remaining: [${this.selectedAreaIds.join(', ')}]`);
  }

  // ─── State Sync ────────────────────────────────────────────────────

  public override setMatterReady(): void {
    super.setMatterReady();
    this.logDebug('Matter ready — syncing initial state');
    this.syncState();
    this.startStateRefresh();
  }

  private setupEventListeners(): void {
    const onTuyaPayload = (source: string, data?: { dps?: Record<string, unknown> }) => {
      const dps = data?.dps ?? {};
      const keys = Object.keys(dps);
      if (OPERATIONAL_DPS_KEYS.some(key => Object.hasOwn(dps, key))) {
        this.logEufyState(`${source} keys=[${keys.join(',')}]`);
      } else {
        this.logDebug(`${source} (non-operational dps=[${keys.join(',') || '(none)'}]) — syncing state`);
      }
      this.syncState();
    };

    this.robovac.on('tuya.data', (data?: { dps?: Record<string, unknown> }) => {
      onTuyaPayload('tuya.data', data);
    });

    // Many devices deliver mid-job updates on dp-refresh rather than data.
    this.robovac.on('tuya.dp-refresh', (data?: { dps?: Record<string, unknown> }) => {
      onTuyaPayload('tuya.dp-refresh', data);
    });

    this.robovac.on('event', (event: RobovacEvent) => {
      // Battery ticks are frequent — keep those at debug; everything else at info for debugging.
      if (event.command === 'battery') {
        this.logDebug(`device event: battery = ${JSON.stringify(event.value)}`);
      } else {
        this.logInfo(`device event: ${event.command} = ${JSON.stringify(event.value)}`);
      }
      if (event.command === 'battery') {
        this.updateBatteryState().catch(e => this.logError('Failed to update battery state:', e));
      } else if (event.command === 'activity') {
        const activity = event.value as string;
        this.logEufyState(`activity event='${activity}'`);
        if (activity === 'Sleeping' || activity === 'completed') {
          const state = EufyRobovacMatterAccessory.dockIdleOperationalState(this.robovac);
          this.logInfo(`activity changed to '${activity}' — transitioning to ${state === OP_CHARGING ? 'Charging' : 'Docked'}`);
          this.updateOperationalState(state).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_IDLE).catch(e => this.logError('Failed to update state:', e));
        } else if (activity === 'Charging') {
          this.logInfo('activity changed to Charging — transitioning to Charging state');
          this.updateOperationalState(OP_CHARGING).catch(e => this.logError('Failed to update state:', e));
        } else if (activity === 'Recharge') {
          this.logInfo('activity changed to Recharge — transitioning to SeekingCharger state');
          this.updateOperationalState(OP_SEEKING_CHARGER).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_IDLE).catch(e => this.logError('Failed to update state:', e));
        } else if (EufyRobovacMatterAccessory.isStandbyActivity(activity)) {
          this.logInfo(`activity changed to '${activity}' — transitioning to Stopped (job ended/idle)`);
          this.updateOperationalState(OP_STOPPED).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_IDLE).catch(e => this.logError('Failed to update state:', e));
        } else {
          // Cleaning / Running / etc. — playPause distinguishes pause vs resume mid-job
          this.logInfo(`activity changed to '${activity}' — running full state sync`);
          this.syncState();
        }
      } else if (event.command === 'goHome') {
        this.logEufyState(`goHome event=${JSON.stringify(event.value)}`);
        if (event.value === false) {
          // goHome flag cleared — robot has stopped seeking charger, re-evaluate actual state
          this.logInfo('goHome flag cleared — syncing state');
          this.syncState();
        }
      } else if (event.command === 'coverage') {
        if ((event.value as number) > 0 && this.currentOperationalState !== OP_RUNNING) {
          this.logInfo(`coverage event received (${event.value}) — inferring Running state`);
          this.updateOperationalState(OP_RUNNING).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_CLEANING).catch(e => this.logError('Failed to update state:', e));
        }
      } else if (event.command === 'playPause') {
        this.logEufyState(`playPause event=${JSON.stringify(event.value)}`);
        // playPause alone is ambiguous (classic mid-job pause vs X8 job-end→standby).
        // Re-evaluate from full activity/playPause snapshot.
        this.logInfo('playPause changed — running full state sync');
        this.syncState();
      } else if (event.command === 'error') {
        const errorValue = event.value as string;
        if (errorValue && mapEufyErrorToMatterErrorState(errorValue) !== MatterErrorState.NoError) {
          this.logWarn(`device error reported: ${errorValue}`);
          this.updateErrorState(errorValue).catch(e => this.logError('Failed to update error state:', e));
          this.updateOperationalState(OP_ERROR).catch(e => this.logError('Failed to update operational state:', e));
        } else {
          this.clearErrorState().catch(e => this.logError('Failed to clear error state:', e));
        }
      } else if (event.command === 'cleanSpeed') {
        const speedMap: { [key: string]: number } = {
          'Quiet': CLEAN_SPEED_QUIET,
          'Standard': CLEAN_SPEED_STANDARD,
          'Turbo': CLEAN_SPEED_TURBO,
          'Max': CLEAN_SPEED_MAX,
        };
        const cleanSpeed = speedMap[event.value as string];
        if (cleanSpeed !== undefined) {
          this.logDebug(`clean speed changed to ${event.value}`);
          this.updateCleanMode(cleanSpeed).catch(e => this.logError('Failed to update clean mode:', e));
        } else {
          this.logWarn(`unknown clean speed: ${event.value}`);
        }
      } else if (event.command === 'workStatus2') {
        this.logEufyState(`workStatus2 event=${JSON.stringify(event.value)}`);
        this.syncState();
      } else if (event.command === 'status' || event.command === 'workMode') {
        // X8 Pro / newer schemas often nest mode/state in status DPS 142.
        this.logEufyState(`${event.command} event`);
        this.syncState();
      }
    });

    this.robovac.on('tuya.disconnected', () => {
      this.logWarn('RoboVac disconnected');
    });

    this.robovac.on('alert', (alert: ConsumableAlert) => {
      this.logInfo(`consumable maintenance alert: ${JSON.stringify(alert)}`);
      if (alert.consumable) {
        this.logWarn(`[MAINTENANCE WARNING] ${alert.consumable}: ${alert.duration}`);
      }
    });
  }

  private syncState(): void {
    if (!this.robovac.connected) {
      this.logDebug('syncState skipped — not connected');
      return;
    }
    this.syncOperationalState();
    this.syncCleanSpeed();
    this.updateBatteryState().catch(e => this.logError('Failed to sync battery state:', e));
  }

  private syncOperationalState(): void {
    if (!this.robovac.connected) {
      return;
    }
    try {
      const error = this.robovac.error();
      if (error && mapEufyErrorToMatterErrorState(error) !== MatterErrorState.NoError) {
        this.logWarn(`device error: ${error}`);
        this.updateErrorState(error).catch(e => this.logError('Failed to update error state:', e));
        this.updateOperationalState(OP_ERROR);
        return;
      }

      this.clearErrorState().catch(e => this.logError('Failed to clear error state:', e));

      const activity = EufyRobovacMatterAccessory.safeActivity(this.robovac);
      if (activity === null) {
        this.logInfo('activity unavailable — using fallback operational state signals');
        this.syncOperationalStateFallback();
        return;
      }

      const playPause = EufyRobovacMatterAccessory.readPlayPause(this.robovac);
      const raw = EufyRobovacMatterAccessory.formatOperationalDps(this.robovac);
      this.logInfo(
        `syncing operational state — activity=${activity} playPause=${playPause ?? 'n/a'} `
        + `matterOp=${EufyRobovacMatterAccessory.operationalStateName(this.currentOperationalState)} `
        + `raw={${raw}}`,
      );

      if (activity === 'Sleeping' || activity === 'completed') {
        const state = EufyRobovacMatterAccessory.dockIdleOperationalState(this.robovac);
        this.logInfo(`→ Matter ${EufyRobovacMatterAccessory.operationalStateName(state)} (dock idle)`);
        this.updateOperationalState(state);
        this.updateRunMode(RUN_IDLE);
        return;
      }
      if (activity === 'Charging') {
        this.logInfo('→ Matter Charging');
        this.updateOperationalState(OP_CHARGING);
        return;
      }

      if (activity === 'Recharge') {
        this.logInfo('→ Matter SeekingCharger (Recharge)');
        this.updateOperationalState(OP_SEEKING_CHARGER);
        this.updateRunMode(RUN_IDLE);
        return;
      }

      if (this.supportsHome() && this.robovac.goingHome()) {
        this.logInfo('→ Matter SeekingCharger (goingHome)');
        this.updateOperationalState(OP_SEEKING_CHARGER);
        return;
      }

      // X8 "standby" = idle off-dock / clean ended (HA maps this to idle), NOT a
      // resumable pause. Classic mid-job pause keeps activity Cleaning/Running with
      // playPause=false.
      if (EufyRobovacMatterAccessory.isStandbyActivity(activity)) {
        this.logInfo(`→ Matter Stopped (activity=${activity} — idle/ended, not paused)`);
        this.updateOperationalState(OP_STOPPED);
        this.updateRunMode(RUN_IDLE);
        return;
      }

      // DPS 122 is the real pause signal on X8-class robots: Pause ↔ Continue while
      // activity stays Running and playPause stays true.
      const workStatus2 = EufyRobovacMatterAccessory.readWorkStatus2(this.robovac);
      if (EufyRobovacMatterAccessory.isWorkStatus2Paused(workStatus2)) {
        this.logInfo(`→ Matter Paused (workStatus2=${workStatus2}, activity=${activity})`);
        this.updateOperationalState(OP_PAUSED);
        return;
      }

      if (playPause === false) {
        this.logInfo(`→ Matter Paused (activity=${activity}, playPause=false)`);
        this.updateOperationalState(OP_PAUSED);
        return;
      }

      this.logInfo(
        `→ Matter Running (activity=${activity}, playPause=${playPause}, workStatus2=${workStatus2 ?? 'n/a'})`,
      );
      this.updateOperationalState(OP_RUNNING);
      this.updateRunMode(RUN_CLEANING);
    } catch (error: unknown) {
      this.logError('Failed to sync operational state:', error);
    }
  }

  /**
   * Infer operational state when activity DPS (15) is missing or not yet received.
   * Common during Matter ready before the first TuyAPI refresh, and on models
   * that omit activity from the DPS schema.
   */
  private syncOperationalStateFallback(): void {
    const playPause = EufyRobovacMatterAccessory.readPlayPause(this.robovac);
    try {
      if (this.supportsHome() && this.robovac.goingHome()) {
        this.logInfo(`fallback → Matter SeekingCharger (goingHome, playPause=${playPause ?? 'n/a'})`);
        this.updateOperationalState(OP_SEEKING_CHARGER);
        this.updateRunMode(RUN_IDLE);
        return;
      }
    } catch {
      // goHome unsupported
    }

    if (playPause === true) {
      this.logInfo('fallback → Matter Running (playPause=true)');
      this.updateOperationalState(OP_RUNNING);
      this.updateRunMode(RUN_CLEANING);
      return;
    }
    if (playPause === false) {
      // playPause=false means idle or paused — not necessarily docked/charging.
      // Never map this to Charging/Docked: those states reject Matter resume.
      // Keep Cleaning run mode when pausing mid-job so Matter resume stays valid.
      if (this.currentOperationalState === OP_PAUSED
        || this.currentOperationalState === OP_RUNNING
        || this.currentOperationalState === OP_ERROR) {
        this.logInfo(
          `fallback → Matter Paused (playPause=false, was ${EufyRobovacMatterAccessory.operationalStateName(this.currentOperationalState)})`,
        );
        this.updateOperationalState(OP_PAUSED);
      } else {
        this.logInfo('fallback → Matter Stopped (playPause=false)');
        this.updateOperationalState(OP_STOPPED);
        this.updateRunMode(RUN_IDLE);
      }
      return;
    }

    this.logInfo(
      `fallback — no playPause/goHome signals yet; keeping Matter ${EufyRobovacMatterAccessory.operationalStateName(this.currentOperationalState)}`,
    );
  }

  private startStateRefresh(): void {
    if (this.stateRefreshIntervalMs <= 0 || this.refreshTimer) {
      return;
    }
    this.logInfo(
      `polling Eufy state every ${this.stateRefreshIntervalMs / 1000}s `
      + '(Eufy app changes often do not push over local Tuya — set stateRefreshInterval=0 to disable)',
    );
    this.refreshTimer = setInterval(() => {
      void this.pollEufyState();
    }, this.stateRefreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  private async pollEufyState(): Promise<void> {
    if (!this.robovac.connected) {
      return;
    }
    try {
      const data = await this.robovac.refresh();
      // Defensive merge — ensures we see the poll snapshot even if TuyAPI skipped emit.
      if (data && typeof data === 'object' && (data as { dps?: Record<string, unknown> }).dps) {
        this.robovac.dps = {
          ...this.robovac.dps,
          ...(data as { dps: Record<string, unknown> }).dps,
        };
      }
      this.logEufyState('poll');
      this.syncState();
    } catch (error: unknown) {
      this.logDebug('state poll failed:', error);
    }
  }

  /**
   * Snapshot of what Eufy is currently reporting — useful when debugging
   * pause/resume / dock sync mismatches in Homebridge logs (no -D needed).
   * Poll snapshots are suppressed when nothing operational changed.
   */
  private logEufyState(reason: string): void {
    const activity = EufyRobovacMatterAccessory.safeActivity(this.robovac);
    const playPause = EufyRobovacMatterAccessory.readPlayPause(this.robovac);
    const playPauseDps = Object.hasOwn(this.robovac.dps ?? {}, '2')
      ? '2'
      : Object.hasOwn(this.robovac.dps ?? {}, '151')
        ? '151'
        : 'none';
    let goingHome: boolean | 'n/a' = 'n/a';
    try {
      goingHome = this.robovac.goingHome();
    } catch {
      // unsupported
    }
    const docked = EufyRobovacMatterAccessory.safeDockedState(this.robovac);
    const battery = EufyRobovacMatterAccessory.safeBatteryLevel(this.robovac);
    const dpsKeys = Object.keys(this.robovac.dps ?? {}).sort((a, b) => Number(a) - Number(b)).join(',') || '(none)';
    let statusSummary = 'n/a';
    try {
      const status = this.robovac.status?.();
      if (status && typeof status === 'object') {
        statusSummary = JSON.stringify(status);
      }
    } catch {
      // status DPS unsupported
    }

    const raw = EufyRobovacMatterAccessory.formatOperationalDps(this.robovac);
    const signature = `${activity}|${playPause}|${goingHome}|${docked}|${this.currentOperationalState}|${raw}`;
    if (reason === 'poll' && signature === this.lastEufyStateSignature) {
      this.logDebug(
        `Eufy state [poll] unchanged: activity=${activity ?? 'n/a'} playPause=${playPause ?? 'n/a'}`,
      );
      return;
    }
    this.lastEufyStateSignature = signature;

    this.logInfo(
      `Eufy state [${reason}]: activity=${activity ?? 'n/a'} `
      + `playPause=${playPause ?? 'n/a'}(dps${playPauseDps}) `
      + `goingHome=${goingHome} docked=${docked} battery=${battery ?? 'n/a'}% `
      + `matterOp=${EufyRobovacMatterAccessory.operationalStateName(this.currentOperationalState)} `
      + `status=${statusSummary} dps=[${dpsKeys}]`,
    );
  }

  private syncCleanSpeed(): void {
    if (!this.robovac.connected) {
      return;
    }
    try {
      const cleanSpeed = EufyRobovacMatterAccessory.safeCleanSpeed(this.robovac);
      if (cleanSpeed !== this.currentCleanSpeed) {
        this.logDebug(`syncing clean speed: ${cleanSpeed}`);
        this.updateCleanMode(cleanSpeed).catch(e => this.logError('Failed to sync clean speed:', e));
      }
    } catch (error: unknown) {
      this.logError('Failed to sync clean speed:', error);
    }
  }

  // ─── State Update Helpers ──────────────────────────────────────────

  public async updateOperationalState(state: number): Promise<void> {
    this.logDebug(`updating operational state: ${state}`);
    this.currentOperationalState = state;
    await this.updateState('rvcOperationalState', { operationalState: state });
    // Prefer explicit Charging; otherwise derive from activity/battery (may be IsAtFullCharge).
    const batChargeState = state === OP_CHARGING
      ? 1
      : EufyRobovacMatterAccessory.computeChargeState(this.robovac);
    await this.updateState('powerSource', { batChargeState });
  }

  public async updateRunMode(mode: number): Promise<void> {
    this.logDebug(`updating run mode: ${mode === RUN_IDLE ? 'Idle' : 'Cleaning'} (${mode})`);
    await this.updateState('rvcRunMode', { currentMode: mode });
  }

  public async updateCleanMode(mode: number): Promise<void> {
    const modeLabel = ['Quiet', 'Standard', 'Turbo', 'Max'][mode] ?? `Unknown (${mode})`;
    this.logDebug(`updating clean mode: ${modeLabel} (${mode})`);
    this.currentCleanSpeed = mode;
    await this.updateState('rvcCleanMode', { currentMode: mode });
  }

  private async updateErrorState(eufyErrorCode: string | number): Promise<void> {
    const matterErrorStateId = mapEufyErrorToMatterErrorState(eufyErrorCode);
    const matterErrorStateName = getMatterErrorStateName(matterErrorStateId);
    const eufyErrorDescription = getEufyErrorDescription(eufyErrorCode);

    this.logDebug(`mapping eufy error '${eufyErrorCode}' (${eufyErrorDescription}) to Matter ErrorState ${matterErrorStateId} (${matterErrorStateName})`);

    this.currentErrorState = matterErrorStateId;

    // Create ErrorStateStruct with mapped error state
    // Note: errorStateLabel is only valid for manufacturer-specific error codes (128-191)
    // Since we use only standard error states (0-78), we omit errorStateLabel
    const operationalError: Record<string, unknown> = {
      errorStateId: matterErrorStateId,
      errorStateDetails: eufyErrorDescription,
    };

    this.logDebug(`updating operational error: ${JSON.stringify(operationalError)}`);
    await this.updateState('rvcOperationalState', { operationalError });
  }

  private async clearErrorState(): Promise<void> {
    this.logDebug('clearing error state');
    this.currentErrorState = 0;
    const operationalError: Record<string, unknown> = {
      errorStateId: 0, // NoError
      errorStateDetails: 'No error',
    };
    await this.updateState('rvcOperationalState', { operationalError });
  }

  private async updateBatteryState(): Promise<void> {
    const level = EufyRobovacMatterAccessory.safeBatteryLevel(this.robovac);
    if (level === null) {
      const dpsKeys = Object.keys(this.robovac.dps ?? {}).join(', ') || '(none)';
      this.logWarn(`battery level unavailable — DPS keys present: ${dpsKeys}`);
      const batChargeState = EufyRobovacMatterAccessory.computeChargeState(this.robovac);
      await this.updateState('powerSource', { batChargeState });
      return;
    }
    const batPercentRemaining = EufyRobovacMatterAccessory.batteryPercentRemaining(level);
    const batChargeLevel = EufyRobovacMatterAccessory.computeChargeLevel(level);
    const batChargeState = EufyRobovacMatterAccessory.computeChargeState(this.robovac);
    this.logDebug(
      `updating battery: ${level}% (batPercentRemaining=${batPercentRemaining}, `
      + `batChargeLevel=${batChargeLevel}, batChargeState=${batChargeState})`,
    );
    await this.updateState('powerSource', { batPercentRemaining, batChargeLevel, batChargeState });
  }

  public getOperationalState(): number {
    return this.currentOperationalState;
  }

  // ─── Utility ───────────────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.robovac.connected) {
      this.logWarn('command rejected — RoboVac is not connected');
      throw new MatterStatus.Failure('RoboVac is not connected');
    }
  }

  private supportsHome(): boolean {
    try {
      this.robovac.goingHome();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns battery percent 0–100, or null when the device has not reported a level yet
   * (missing DPS 104/163 / status.bat). Callers must not treat null as 100%.
   */
  static safeBatteryLevel(robovac: RoboVac): number | null {
    try {
      const level = robovac.batteryLevel();
      if (typeof level !== 'number' || !Number.isFinite(level) || level < 0) {
        return null;
      }
      return Math.max(0, Math.min(100, level));
    } catch {
      return null;
    }
  }

  static batteryPercentRemaining(level: number | null): number {
    // Matter batPercentRemaining is in half-percent units (100% = 200).
    // When unknown, report 200 so Home still shows a value; charge state carries uncertainty.
    const percent = level ?? 100;
    return Math.max(0, Math.min(200, Math.round(percent * 2)));
  }

  /**
   * When idle on the dock: Charging if battery is below 100% or unknown; Docked only when full.
   */
  static dockIdleOperationalState(robovac: RoboVac): number {
    const docked = this.safeDockedState(robovac);
    const level = this.safeBatteryLevel(robovac);
    if (docked && (level === null || level < 100)) {
      return OP_CHARGING;
    }
    return OP_DOCKED;
  }

  static safeActivity(robovac: RoboVac): string | null {
    try {
      const activity = robovac.activity();
      if (!activity || activity === 'unknown') {
        return null;
      }
      return activity;
    } catch {
      return null;
    }
  }

  /**
   * Classic DPS 2 or alternate DPS 151 (X8 Pro / newer schemas).
   * When both exist and disagree, prefer alt — classic can be stale after partial updates.
   */
  static readPlayPause(robovac: RoboVac): boolean | undefined {
    const classic = robovac.dps?.['2'];
    const alt = robovac.dps?.['151'];
    if (typeof classic === 'boolean' && typeof alt === 'boolean' && classic !== alt) {
      return alt;
    }
    if (typeof alt === 'boolean') {
      return alt;
    }
    if (typeof classic === 'boolean') {
      return classic;
    }
    return undefined;
  }

  /**
   * Off-dock idle / clean finished. X8 uses "standby"; some firmware uses StandingBy.
   * This is NOT a resumable Matter Paused state.
   */
  static isStandbyActivity(activity: string | null): boolean {
    if (!activity) {
      return false;
    }
    const normalized = activity.toLowerCase();
    return normalized === 'standby' || normalized === 'standingby';
  }

  static readWorkStatus2(robovac: RoboVac): string | undefined {
    const value = robovac.dps?.['122'];
    return typeof value === 'string' ? value : undefined;
  }

  static isWorkStatus2Paused(workStatus2: string | undefined): boolean {
    return typeof workStatus2 === 'string' && workStatus2.toLowerCase() === 'pause';
  }

  /** Compact raw operational DPS for debug logs. */
  static formatOperationalDps(robovac: RoboVac): string {
    const dps = robovac.dps ?? {};
    return OPERATIONAL_DPS_KEYS
      .filter(key => Object.hasOwn(dps, key))
      .map(key => `${key}:${JSON.stringify(dps[key])}`)
      .join(' ') || 'none';
  }

  static operationalStateName(state: number): string {
    switch (state) {
    case OP_STOPPED: return 'Stopped';
    case OP_RUNNING: return 'Running';
    case OP_PAUSED: return 'Paused';
    case OP_ERROR: return 'Error';
    case OP_SEEKING_CHARGER: return 'SeekingCharger';
    case OP_CHARGING: return 'Charging';
    case OP_DOCKED: return 'Docked';
    default: return `Unknown(${state})`;
    }
  }

  static safeDockedState(robovac: RoboVac): boolean {
    try {
      return robovac.docked();
    } catch {
      return false;
    }
  }

  static safeCleanSpeed(robovac: RoboVac): number {
    try {
      const speedMap: { [key: string]: number } = {
        'Quiet': CLEAN_SPEED_QUIET,
        'Standard': CLEAN_SPEED_STANDARD,
        'Turbo': CLEAN_SPEED_TURBO,
        'Max': CLEAN_SPEED_MAX,
      };
      // dps['102'] (classic) or dps['158'] (newer schema) contains the clean speed value string
      const cleanSpeedValue = robovac.dps?.['102'] ?? robovac.dps?.['158'];
      if (cleanSpeedValue === undefined) {
        return CLEAN_SPEED_STANDARD;
      }
      const mappedSpeed = speedMap[cleanSpeedValue];
      return mappedSpeed !== undefined ? mappedSpeed : CLEAN_SPEED_STANDARD;
    } catch {
      return CLEAN_SPEED_STANDARD;
    }
  }

  static computeChargeLevel(percentage: number): number {
    if (percentage < 20) {
      return 2; // Critical
    }
    if (percentage < 40) {
      return 1; // Warning
    }
    return 0; // Ok
  }

  static computeChargeState(robovac: RoboVac): number {
    try {
      const activity = this.safeActivity(robovac);
      const level = this.safeBatteryLevel(robovac);
      if (activity === 'Charging') {
        return 1; // IsCharging
      }
      if ((activity === 'Sleeping' || activity === 'completed') && this.safeDockedState(robovac)) {
        if (level === null) {
          return 1; // IsCharging — unknown percent while docked; avoid stuck "No"
        }
        if (level < 100) {
          return 1; // IsCharging
        }
        return 2; // IsAtFullCharge
      }
      if (activity === null) {
        return 0; // Unknown
      }
      return 3; // IsNotCharging
    } catch {
      return 0; // Unknown
    }
  }
}
