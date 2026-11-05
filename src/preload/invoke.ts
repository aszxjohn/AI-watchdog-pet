import { ipcRenderer } from 'electron';
import {
  ipcFailure,
  parseIpcResult,
  type IpcArgs,
  type IpcContract,
  type IpcData,
  type IpcResult,
} from '../shared/ipc';

/**
 * Invokes a channel and validates main's reply against the shared contract.
 * Never rejects: the renderer only ever sees an IpcResult.
 */
export async function invoke<C extends IpcContract>(
  contract: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<IpcData<C>>> {
  let reply: unknown;
  try {
    reply = await ipcRenderer.invoke(contract.channel, ...args);
  } catch (error) {
    console.error(`[awp] ${contract.channel}: invoke failed`, error);
    return ipcFailure('invoke-failed', `invoke ${contract.channel} failed`);
  }
  const result = parseIpcResult(contract, reply);
  if (!result.ok && result.error.code === 'invalid-response') {
    console.error(`[awp] ${contract.channel}: ${result.error.message}`);
  }
  return result;
}
