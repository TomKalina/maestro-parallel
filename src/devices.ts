// Device discovery for Android (USB + emulators) and iOS (booted simulators
// + connected USB devices). Each helper returns [] when its CLI is missing,
// so projects on Linux without xcrun still see Android devices.

import { join } from '@std/path';
import { has, run } from './exec.ts';
import type { Device, DeviceKind } from './types.ts';
import { C } from './ui.ts';

/**
 * Returns adb entries that are in a non-`device` state (unauthorized,
 * offline, no permissions, …). Maestro 2.5.1 fails to match ANY device by
 * UDID when an unauthorized entry sits in `adb devices` output — surface
 * these so the user can unplug or `adb -s <id> reconnect` first.
 */
export async function detectBrokenAndroidDevices(): Promise<{ id: string; state: string }[]> {
  if (!(await has('adb'))) return [];
  const r = await run('adb', ['devices']);
  if (r.code !== 0) return [];
  const broken: { id: string; state: string }[] = [];
  for (const raw of r.stdout.split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith('*')) continue;
    const [id, state] = line.split(/\s+/);
    if (id && state && state !== 'device') broken.push({ id, state });
  }
  return broken;
}

async function listAndroid(): Promise<Device[]> {
  if (!(await has('adb'))) return [];
  const r = await run('adb', ['devices', '-l']);
  if (r.code !== 0) return [];
  const out: Device[] = [];
  for (const raw of r.stdout.split('\n').slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const [id, state] = line.split(/\s+/);
    if (state !== 'device' || !id) continue;
    const rawModel = line.match(/model:(\S+)/)?.[1] ?? '';
    const displayName = rawModel ? rawModel.replace(/_/g, ' ') : id;
    const kind: DeviceKind = id.startsWith('emulator-') ? 'emulator' : 'usb';
    const v = await run('adb', ['-s', id, 'shell', 'getprop', 'ro.build.version.release']);
    const b = await run('adb', ['-s', id, 'shell', 'dumpsys', 'battery']);
    const batteryLevel = b.stdout.match(/level:\s*(\d+)/)?.[1];
    out.push({
      platform: 'android',
      kind,
      id,
      name: displayName,
      buildTargetId: rawModel || id,
      os: v.code === 0 ? `Android ${v.stdout.trim()}` : undefined,
      battery: b.code === 0 && batteryLevel ? `${batteryLevel}%` : undefined,
    });
  }
  return out;
}

interface SimctlListOutput {
  devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
}

async function listIosSimulators(): Promise<Device[]> {
  if (!(await has('xcrun'))) return [];
  const r = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
  if (r.code !== 0) return [];
  const out: Device[] = [];
  try {
    const parsed = JSON.parse(r.stdout) as SimctlListOutput;
    for (const [runtime, devices] of Object.entries(parsed.devices)) {
      const m = runtime.match(/^com\.apple\.CoreSimulator\.SimRuntime\.([^-]+)-(.+)$/);
      const os = m ? `${m[1]} ${m[2]?.replace(/-/g, '.') ?? ''}` : runtime;
      for (const d of devices) {
        if (d.state !== 'Booted') continue;
        out.push({
          platform: 'ios',
          kind: 'simulator',
          id: d.udid,
          name: d.name,
          buildTargetId: d.udid,
          os,
        });
      }
    }
  } catch { /* ignore */ }
  return out;
}

interface DevicectlOutput {
  result?: {
    devices?: Array<{
      identifier?: string;
      deviceProperties?: { name?: string; osVersionNumber?: string };
      connectionProperties?: {
        tunnelState?: string;
        pairingState?: string;
        transportType?: string;
      };
      hardwareProperties?: { udid?: string; platform?: string };
    }>;
  };
}

async function listIosPhysical(): Promise<Device[]> {
  if (!(await has('xcrun'))) return [];
  const dir = await Deno.makeTempDir({ prefix: 'maestro-parallel-' });
  const tmpJson = join(dir, 'devices.json');
  try {
    const r = await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmpJson]);
    if (r.code !== 0) return [];
    const parsed = JSON.parse(await Deno.readTextFile(tmpJson)) as DevicectlOutput;
    const out: Device[] = [];
    for (const d of parsed.result?.devices ?? []) {
      if (d.hardwareProperties?.platform && d.hardwareProperties.platform !== 'iOS') continue;
      // Accept paired devices that are reachable. `tunnelState`:
      //   - 'connected'    — tunnel up right now
      //   - 'disconnected' — paired, tunnel decayed between runs (Maestro
      //                       re-establishes on demand — keep)
      //   - 'unavailable'  — paired previously but not currently reachable
      //                       (USB unplugged / device asleep — skip so it
      //                        doesn't pollute the picker)
      // Both `wired` and `wireless` (Wi-Fi sync) transports are driveable
      // once the CoreDevice tunnel is up.
      const cp = d.connectionProperties ?? {};
      const paired = cp.pairingState === 'paired';
      const reachable = cp.tunnelState !== 'unavailable';
      if (!paired || !reachable) continue;
      const id = d.hardwareProperties?.udid ?? d.identifier;
      if (!id) continue;
      out.push({
        platform: 'ios',
        kind: 'usb',
        id,
        name: d.deviceProperties?.name ?? id,
        buildTargetId: id,
        os: d.deviceProperties?.osVersionNumber
          ? `iOS ${d.deviceProperties.osVersionNumber}`
          : undefined,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

export async function discoverDevices(): Promise<Device[]> {
  const [a, s, p] = await Promise.all([listAndroid(), listIosSimulators(), listIosPhysical()]);
  return [...a, ...s, ...p];
}

export function deviceLabel(d: Device): string {
  const tag = `[${d.platform.toUpperCase()} ${d.kind.toUpperCase()}]`;
  const meta = [d.os, d.battery && `🔋 ${d.battery}`].filter(Boolean).join(' · ');
  return `${tag} ${d.name}  ${C.gray}${d.id}${meta ? ` · ${meta}` : ''}${C.reset}`;
}

export function deviceSlug(d: Device): string {
  return `${d.platform}-${d.name.replace(/[^A-Za-z0-9]+/g, '_')}-${d.id.slice(0, 8)}`;
}

export function devicePrefix(d: Device, color: string, width: number): string {
  const label = `${d.platform === 'android' ? 'and' : 'ios'}:${d.name}`;
  const padded = label.length > width ? label.slice(0, width) : label.padEnd(width);
  return `${color}[${padded}]${C.reset} `;
}
