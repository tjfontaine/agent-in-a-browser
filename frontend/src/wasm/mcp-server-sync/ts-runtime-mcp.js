import { monotonicClock, wallClock } from '../clocks-impl.js';
import { LazyProcess, getLazyModule, spawnLazyCommand } from '../module-loader-impl.js';
import { preopens, types } from '../opfs-filesystem-impl.js';
import { Fields, FutureIncomingResponse, FutureTrailers, IncomingBody, IncomingRequest, IncomingResponse, OutgoingBody, OutgoingRequest, OutgoingResponse, RequestOptions, ResponseOutparam, outgoingHandler } from '../wasi-http-impl.js';
import { environment, exit as exit$1, stderr, stdin, stdout, terminalInput, terminalOutput, terminalStderr, terminalStdin, terminalStdout } from '@bytecodealliance/preview2-shim/cli';
import { error, poll, streams } from '@bytecodealliance/preview2-shim/io';
import { insecureSeed as insecureSeed$1, random } from '@bytecodealliance/preview2-shim/random';
const { now,
  subscribeDuration } = monotonicClock;
const { now: now$1 } = wallClock;
const { getDirectories } = preopens;
const { Descriptor,
  DirectoryEntryStream,
  filesystemErrorCode } = types;
const { handle } = outgoingHandler;
const { getEnvironment } = environment;
const { exit } = exit$1;
const { getStderr } = stderr;
const { getStdin } = stdin;
const { getStdout } = stdout;
const { TerminalInput } = terminalInput;
const { TerminalOutput } = terminalOutput;
const { getTerminalStderr } = terminalStderr;
const { getTerminalStdin } = terminalStdin;
const { getTerminalStdout } = terminalStdout;
const { Error: Error$1 } = error;
const { Pollable } = poll;
const { InputStream,
  OutputStream } = streams;
const { insecureSeed } = insecureSeed$1;
const { getRandomBytes,
  getRandomU64 } = random;

let dv = new DataView(new ArrayBuffer());
const dataView = mem => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);

const toUint64 = val => BigInt.asUintN(64, BigInt(val));

function toInt32(val) {
  return val >> 0;
}

function toUint16(val) {
  val >>>= 0;
  val %= 2 ** 16;
  return val;
}

function toUint32(val) {
  return val >>> 0;
}

function toUint8(val) {
  val >>>= 0;
  val %= 2 ** 8;
  return val;
}

const utf8Decoder = new TextDecoder();

const utf8Encoder = new TextEncoder();
let utf8EncodedLen = 0;
function utf8Encode(s, realloc, memory) {
  if (typeof s !== 'string') throw new TypeError('expected a string');
  if (s.length === 0) {
    utf8EncodedLen = 0;
    return 1;
  }
  let buf = utf8Encoder.encode(s);
  let ptr = realloc(0, 0, 1, buf.length);
  new Uint8Array(memory.buffer).set(buf, ptr);
  utf8EncodedLen = buf.length;
  return ptr;
}

const T_FLAG = 1 << 30;

function rscTableCreateOwn (table, rep) {
  const free = table[0] & ~T_FLAG;
  if (free === 0) {
    table.push(0);
    table.push(rep | T_FLAG);
    return (table.length >> 1) - 1;
  }
  table[0] = table[free << 1];
  table[free << 1] = 0;
  table[(free << 1) + 1] = rep | T_FLAG;
  return free;
}

function rscTableRemove (table, handle) {
  const scope = table[handle << 1];
  const val = table[(handle << 1) + 1];
  const own = (val & T_FLAG) !== 0;
  const rep = val & ~T_FLAG;
  if (val === 0 || (scope & T_FLAG) !== 0) throw new TypeError('Invalid handle');
  table[handle << 1] = table[0] | T_FLAG;
  table[0] = handle | T_FLAG;
  return { rep, scope, own };
}

let curResourceBorrows = [];

let NEXT_TASK_ID = 0n;
function startCurrentTask(componentIdx, isAsync, entryFnName) {
  _debugLog('[startCurrentTask()] args', { componentIdx, isAsync });
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing/invalid component instance index while starting task');
  }
  const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
  
  const nextId = ++NEXT_TASK_ID;
  const newTask = new AsyncTask({ id: nextId, componentIdx, isAsync, entryFnName });
  const newTaskMeta = { id: nextId, componentIdx, task: newTask };
  
  ASYNC_CURRENT_TASK_IDS.push(nextId);
  ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx);
  
  if (!tasks) {
    ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx, [newTaskMeta]);
    return nextId;
  } else {
    tasks.push(newTaskMeta);
  }
  
  return nextId;
}

function endCurrentTask(componentIdx, taskId) {
  _debugLog('[endCurrentTask()] args', { componentIdx });
  componentIdx ??= ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
  taskId ??= ASYNC_CURRENT_TASK_IDS.at(-1);
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing/invalid component instance index while ending current task');
  }
  const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
  if (!tasks || !Array.isArray(tasks)) {
    throw new Error('missing/invalid tasks for component instance while ending task');
  }
  if (tasks.length == 0) {
    throw new Error('no current task(s) for component instance while ending task');
  }
  
  if (taskId) {
    const last = tasks[tasks.length - 1];
    if (last.id !== taskId) {
      throw new Error('current task does not match expected task ID');
    }
  }
  
  ASYNC_CURRENT_TASK_IDS.pop();
  ASYNC_CURRENT_COMPONENT_IDXS.pop();
  
  return tasks.pop();
}
const ASYNC_TASKS_BY_COMPONENT_IDX = new Map();
const ASYNC_CURRENT_TASK_IDS = [];
const ASYNC_CURRENT_COMPONENT_IDXS = [];

class AsyncTask {
  static State = {
    INITIAL: 'initial',
    CANCELLED: 'cancelled',
    CANCEL_PENDING: 'cancel-pending',
    CANCEL_DELIVERED: 'cancel-delivered',
    RESOLVED: 'resolved',
  }
  
  static BlockResult = {
    CANCELLED: 'block.cancelled',
    NOT_CANCELLED: 'block.not-cancelled',
  }
  
  #id;
  #componentIdx;
  #state;
  #isAsync;
  #onResolve = null;
  #entryFnName = null;
  #subtasks = [];
  #completionPromise = null;
  
  cancelled = false;
  requested = false;
  alwaysTaskReturn = false;
  
  returnCalls =  0;
  storage = [0, 0];
  borrowedHandles = {};
  
  awaitableResume = null;
  awaitableCancel = null;
  
  
  constructor(opts) {
    if (opts?.id === undefined) { throw new TypeError('missing task ID during task creation'); }
    this.#id = opts.id;
    if (opts?.componentIdx === undefined) {
      throw new TypeError('missing component id during task creation');
    }
    this.#componentIdx = opts.componentIdx;
    this.#state = AsyncTask.State.INITIAL;
    this.#isAsync = opts?.isAsync ?? false;
    this.#entryFnName = opts.entryFnName;
    
    const {
      promise: completionPromise,
      resolve: resolveCompletionPromise,
      reject: rejectCompletionPromise,
    } = Promise.withResolvers();
    this.#completionPromise = completionPromise;
    
    this.#onResolve = (results) => {
      // TODO: handle external facing cancellation (should likely be a rejection)
      resolveCompletionPromise(results);
    }
  }
  
  taskState() { return this.#state.slice(); }
  id() { return this.#id; }
  componentIdx() { return this.#componentIdx; }
  isAsync() { return this.#isAsync; }
  entryFnName() { return this.#entryFnName; }
  completionPromise() { return this.#completionPromise; }
  
  mayEnter(task) {
    const cstate = getOrCreateAsyncState(this.#componentIdx);
    if (!cstate.backpressure) {
      _debugLog('[AsyncTask#mayEnter()] disallowed due to backpressure', { taskID: this.#id });
      return false;
    }
    if (!cstate.callingSyncImport()) {
      _debugLog('[AsyncTask#mayEnter()] disallowed due to sync import call', { taskID: this.#id });
      return false;
    }
    const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
    if (!callingSyncExportWithSyncPending) {
      _debugLog('[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending', { taskID: this.#id });
      return false;
    }
    return true;
  }
  
  async enter() {
    _debugLog('[AsyncTask#enter()] args', { taskID: this.#id });
    
    // TODO: assert scheduler locked
    // TODO: trap if on the stack
    
    const cstate = getOrCreateAsyncState(this.#componentIdx);
    
    let mayNotEnter = !this.mayEnter(this);
    const componentHasPendingTasks = cstate.pendingTasks > 0;
    if (mayNotEnter || componentHasPendingTasks) {
      throw new Error('in enter()'); // TODO: remove
      cstate.pendingTasks.set(this.#id, new Awaitable(new Promise()));
      
      const blockResult = await this.onBlock(awaitable);
      if (blockResult) {
        // TODO: find this pending task in the component
        const pendingTask = cstate.pendingTasks.get(this.#id);
        if (!pendingTask) {
          throw new Error('pending task [' + this.#id + '] not found for component instance');
        }
        cstate.pendingTasks.remove(this.#id);
        this.#onResolve(new Error('failed enter'));
        return false;
      }
      
      mayNotEnter = !this.mayEnter(this);
      if (!mayNotEnter || !cstate.startPendingTask) {
        throw new Error('invalid component entrance/pending task resolution');
      }
      cstate.startPendingTask = false;
    }
    
    if (!this.isAsync) { cstate.callingSyncExport = true; }
    
    return true;
  }
  
  async waitForEvent(opts) {
    const { waitableSetRep, isAsync } = opts;
    _debugLog('[AsyncTask#waitForEvent()] args', { taskID: this.#id, waitableSetRep, isAsync });
    
    if (this.#isAsync !== isAsync) {
      throw new Error('async waitForEvent called on non-async task');
    }
    
    if (this.status === AsyncTask.State.CANCEL_PENDING) {
      this.#state = AsyncTask.State.CANCEL_DELIVERED;
      return {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
      };
    }
    
    const state = getOrCreateAsyncState(this.#componentIdx);
    const waitableSet = state.waitableSets.get(waitableSetRep);
    if (!waitableSet) { throw new Error('missing/invalid waitable set'); }
    
    waitableSet.numWaiting += 1;
    let event = null;
    
    while (event == null) {
      const awaitable = new Awaitable(waitableSet.getPendingEvent());
      const waited = await this.blockOn({ awaitable, isAsync, isCancellable: true });
      if (waited) {
        if (this.#state !== AsyncTask.State.INITIAL) {
          throw new Error('task should be in initial state found [' + this.#state + ']');
        }
        this.#state = AsyncTask.State.CANCELLED;
        return {
          code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        };
      }
      
      event = waitableSet.poll();
    }
    
    waitableSet.numWaiting -= 1;
    return event;
  }
  
  waitForEventSync(opts) {
    throw new Error('AsyncTask#yieldSync() not implemented')
  }
  
  async pollForEvent(opts) {
    const { waitableSetRep, isAsync } = opts;
    _debugLog('[AsyncTask#pollForEvent()] args', { taskID: this.#id, waitableSetRep, isAsync });
    
    if (this.#isAsync !== isAsync) {
      throw new Error('async pollForEvent called on non-async task');
    }
    
    throw new Error('AsyncTask#pollForEvent() not implemented');
  }
  
  pollForEventSync(opts) {
    throw new Error('AsyncTask#yieldSync() not implemented')
  }
  
  async blockOn(opts) {
    const { awaitable, isCancellable, forCallback } = opts;
    _debugLog('[AsyncTask#blockOn()] args', { taskID: this.#id, awaitable, isCancellable, forCallback });
    
    if (awaitable.resolved() && !ASYNC_DETERMINISM && _coinFlip()) {
      return AsyncTask.BlockResult.NOT_CANCELLED;
    }
    
    const cstate = getOrCreateAsyncState(this.#componentIdx);
    if (forCallback) { cstate.exclusiveRelease(); }
    
    let cancelled = await this.onBlock(awaitable);
    if (cancelled === AsyncTask.BlockResult.CANCELLED && !isCancellable) {
      const secondCancel = await this.onBlock(awaitable);
      if (secondCancel !== AsyncTask.BlockResult.NOT_CANCELLED) {
        throw new Error('uncancellable task was canceled despite second onBlock()');
      }
    }
    
    if (forCallback) {
      const acquired = new Awaitable(cstate.exclusiveLock());
      cancelled = await this.onBlock(acquired);
      if (cancelled === AsyncTask.BlockResult.CANCELLED) {
        const secondCancel = await this.onBlock(acquired);
        if (secondCancel !== AsyncTask.BlockResult.NOT_CANCELLED) {
          throw new Error('uncancellable callback task was canceled despite second onBlock()');
        }
      }
    }
    
    if (cancelled === AsyncTask.BlockResult.CANCELLED) {
      if (this.#state !== AsyncTask.State.INITIAL) {
        throw new Error('cancelled task is not at initial state');
      }
      if (isCancellable) {
        this.#state = AsyncTask.State.CANCELLED;
        return AsyncTask.BlockResult.CANCELLED;
      } else {
        this.#state = AsyncTask.State.CANCEL_PENDING;
        return AsyncTask.BlockResult.NOT_CANCELLED;
      }
    }
    
    return AsyncTask.BlockResult.NOT_CANCELLED;
  }
  
  async onBlock(awaitable) {
    _debugLog('[AsyncTask#onBlock()] args', { taskID: this.#id, awaitable });
    if (!(awaitable instanceof Awaitable)) {
      throw new Error('invalid awaitable during onBlock');
    }
    
    // Build a promise that this task can await on which resolves when it is awoken
    const { promise, resolve, reject } = Promise.withResolvers();
    this.awaitableResume = () => {
      _debugLog('[AsyncTask] resuming after onBlock', { taskID: this.#id });
      resolve();
    };
    this.awaitableCancel = (err) => {
      _debugLog('[AsyncTask] rejecting after onBlock', { taskID: this.#id, err });
      reject(err);
    };
    
    // Park this task/execution to be handled later
    const state = getOrCreateAsyncState(this.#componentIdx);
    state.parkTaskOnAwaitable({ awaitable, task: this });
    
    try {
      await promise;
      return AsyncTask.BlockResult.NOT_CANCELLED;
    } catch (err) {
      // rejection means task cancellation
      return AsyncTask.BlockResult.CANCELLED;
    }
  }
  
  async asyncOnBlock(awaitable) {
    _debugLog('[AsyncTask#asyncOnBlock()] args', { taskID: this.#id, awaitable });
    if (!(awaitable instanceof Awaitable)) {
      throw new Error('invalid awaitable during onBlock');
    }
    // TODO: watch for waitable AND cancellation
    // TODO: if it WAS cancelled:
    // - return true
    // - only once per subtask
    // - do not wait on the scheduler
    // - control flow should go to the subtask (only once)
    // - Once subtask blocks/resolves, reqlinquishControl() will tehn resolve request_cancel_end (without scheduler lock release)
    // - control flow goes back to request_cancel
    //
    // Subtask cancellation should work similarly to an async import call -- runs sync up until
    // the subtask blocks or resolves
    //
    throw new Error('AsyncTask#asyncOnBlock() not yet implemented');
  }
  
  async yield(opts) {
    const { isCancellable, forCallback } = opts;
    _debugLog('[AsyncTask#yield()] args', { taskID: this.#id, isCancellable, forCallback });
    
    if (isCancellable && this.status === AsyncTask.State.CANCEL_PENDING) {
      this.#state = AsyncTask.State.CANCELLED;
      return {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        payload: [0, 0],
      };
    }
    
    // TODO: Awaitables need to *always* trigger the parking mechanism when they're done...?
    // TODO: Component async state should remember which awaitables are done and work to clear tasks waiting
    
    const blockResult = await this.blockOn({
      awaitable: new Awaitable(new Promise(resolve => setTimeout(resolve, 0))),
      isCancellable,
      forCallback,
    });
    
    if (blockResult === AsyncTask.BlockResult.CANCELLED) {
      if (this.#state !== AsyncTask.State.INITIAL) {
        throw new Error('task should be in initial state found [' + this.#state + ']');
      }
      this.#state = AsyncTask.State.CANCELLED;
      return {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        payload: [0, 0],
      };
    }
    
    return {
      code: ASYNC_EVENT_CODE.NONE,
      payload: [0, 0],
    };
  }
  
  yieldSync(opts) {
    throw new Error('AsyncTask#yieldSync() not implemented')
  }
  
  cancel() {
    _debugLog('[AsyncTask#cancel()] args', { });
    if (!this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
      throw new Error('invalid task state for cancellation');
    }
    if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
    
    this.#onResolve(new Error('cancelled'));
    this.#state = AsyncTask.State.RESOLVED;
  }
  
  resolve(results) {
    _debugLog('[AsyncTask#resolve()] args', { results });
    if (this.#state === AsyncTask.State.RESOLVED) {
      throw new Error('task is already resolved');
    }
    if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
    this.#onResolve(results.length === 1 ? results[0] : results);
    this.#state = AsyncTask.State.RESOLVED;
  }
  
  exit() {
    _debugLog('[AsyncTask#exit()] args', { });
    
    // TODO: ensure there is only one task at a time (scheduler.lock() functionality)
    if (this.#state !== AsyncTask.State.RESOLVED) {
      throw new Error('task exited without resolution');
    }
    if (this.borrowedHandles > 0) {
      throw new Error('task exited without clearing borrowed handles');
    }
    
    const state = getOrCreateAsyncState(this.#componentIdx);
    if (!state) { throw new Error('missing async state for component [' + this.#componentIdx + ']'); }
    if (!this.#isAsync && !state.inSyncExportCall) {
      throw new Error('sync task must be run from components known to be in a sync export call');
    }
    state.inSyncExportCall = false;
    
    this.startPendingTask();
  }
  
  startPendingTask(args) {
    _debugLog('[AsyncTask#startPendingTask()] args', args);
    throw new Error('AsyncTask#startPendingTask() not implemented');
  }
  
  createSubtask(args) {
    _debugLog('[AsyncTask#createSubtask()] args', args);
    const newSubtask = new AsyncSubtask({
      componentIdx: this.componentIdx(),
      taskID: this.id(),
      memoryIdx: args?.memoryIdx,
    });
    this.#subtasks.push(newSubtask);
    return newSubtask;
  }
  
  currentSubtask() {
    _debugLog('[AsyncTask#currentSubtask()]');
    if (this.#subtasks.length === 0) { throw new Error('no current subtask'); }
    return this.#subtasks.at(-1);
  }
  
  endCurrentSubtask() {
    _debugLog('[AsyncTask#endCurrentSubtask()]');
    if (this.#subtasks.length === 0) { throw new Error('cannot end current subtask: no current subtask'); }
    const subtask = this.#subtasks.pop();
    subtask.drop();
    return subtask;
  }
}

function unpackCallbackResult(result) {
  _debugLog('[unpackCallbackResult()] args', { result });
  if (!(_typeCheckValidI32(result))) { throw new Error('invalid callback return value [' + result + '], not a valid i32'); }
  const eventCode = result & 0xF;
  if (eventCode < 0 || eventCode > 3) {
    throw new Error('invalid async return value [' + eventCode + '], outside callback code range');
  }
  if (result < 0 || result >= 2**32) { throw new Error('invalid callback result'); }
  // TODO: table max length check?
  const waitableSetIdx = result >> 4;
  return [eventCode, waitableSetIdx];
}
const ASYNC_STATE = new Map();

function getOrCreateAsyncState(componentIdx, init) {
  if (!ASYNC_STATE.has(componentIdx)) {
    ASYNC_STATE.set(componentIdx, new ComponentAsyncState());
  }
  return ASYNC_STATE.get(componentIdx);
}

class ComponentAsyncState {
  #callingAsyncImport = false;
  #syncImportWait = Promise.withResolvers();
  #lock = null;
  
  mayLeave = true;
  waitableSets = new RepTable();
  waitables = new RepTable();
  
  #parkedTasks = new Map();
  
  callingSyncImport(val) {
    if (val === undefined) { return this.#callingAsyncImport; }
    if (typeof val !== 'boolean') { throw new TypeError('invalid setting for async import'); }
    const prev = this.#callingAsyncImport;
    this.#callingAsyncImport = val;
    if (prev === true && this.#callingAsyncImport === false) {
      this.#notifySyncImportEnd();
    }
  }
  
  #notifySyncImportEnd() {
    const existing = this.#syncImportWait;
    this.#syncImportWait = Promise.withResolvers();
    existing.resolve();
  }
  
  async waitForSyncImportCallEnd() {
    await this.#syncImportWait.promise;
  }
  
  parkTaskOnAwaitable(args) {
    if (!args.awaitable) { throw new TypeError('missing awaitable when trying to park'); }
    if (!args.task) { throw new TypeError('missing task when trying to park'); }
    const { awaitable, task } = args;
    
    let taskList = this.#parkedTasks.get(awaitable.id());
    if (!taskList) {
      taskList = [];
      this.#parkedTasks.set(awaitable.id(), taskList);
    }
    taskList.push(task);
    
    this.wakeNextTaskForAwaitable(awaitable);
  }
  
  wakeNextTaskForAwaitable(awaitable) {
    if (!awaitable) { throw new TypeError('missing awaitable when waking next task'); }
    const awaitableID = awaitable.id();
    
    const taskList = this.#parkedTasks.get(awaitableID);
    if (!taskList || taskList.length === 0) {
      _debugLog('[ComponentAsyncState] no tasks waiting for awaitable', { awaitableID: awaitable.id() });
      return;
    }
    
    let task = taskList.shift(); // todo(perf)
    if (!task) { throw new Error('no task in parked list despite previous check'); }
    
    if (!task.awaitableResume) {
      throw new Error('task ready due to awaitable is missing resume', { taskID: task.id(), awaitableID });
    }
    task.awaitableResume();
  }
  
  async exclusiveLock() {  // TODO: use atomics
  if (this.#lock === null) {
    this.#lock = { ticket: 0n };
  }
  
  // Take a ticket for the next valid usage
  const ticket = ++this.#lock.ticket;
  
  _debugLog('[ComponentAsyncState#exclusiveLock()] locking', {
    currentTicket: ticket - 1n,
    ticket
  });
  
  // If there is an active promise, then wait for it
  let finishedTicket;
  while (this.#lock.promise) {
    finishedTicket = await this.#lock.promise;
    if (finishedTicket === ticket - 1n) { break; }
  }
  
  const { promise, resolve } = Promise.withResolvers();
  this.#lock = {
    ticket,
    promise,
    resolve,
  };
  
  return this.#lock.promise;
}

exclusiveRelease() {
  _debugLog('[ComponentAsyncState#exclusiveRelease()] releasing', {
    currentTicket: this.#lock === null ? 'none' : this.#lock.ticket,
  });
  
  if (this.#lock === null) { return; }
  
  const existingLock = this.#lock;
  this.#lock = null;
  existingLock.resolve(existingLock.ticket);
}

isExclusivelyLocked() { return this.#lock !== null; }

}

function prepareCall(memoryIdx) {
  _debugLog('[prepareCall()] args', { memoryIdx });
  
  const taskMeta = getCurrentTask(ASYNC_CURRENT_COMPONENT_IDXS.at(-1), ASYNC_CURRENT_TASK_IDS.at(-1));
  if (!taskMeta) { throw new Error('invalid/missing current async task meta during prepare call'); }
  
  const task = taskMeta.task;
  if (!task) { throw new Error('unexpectedly missing task in task meta during prepare call'); }
  
  const state = getOrCreateAsyncState(task.componentIdx());
  if (!state) {
    throw new Error('invalid/missing async state for component instance [' + componentInstanceID + ']');
  }
  
  const subtask = task.createSubtask({
    memoryIdx,
  });
  
}

function asyncStartCall(callbackIdx, postReturnIdx) {
  _debugLog('[asyncStartCall()] args', { callbackIdx, postReturnIdx });
  
  const taskMeta = getCurrentTask(ASYNC_CURRENT_COMPONENT_IDXS.at(-1), ASYNC_CURRENT_TASK_IDS.at(-1));
  if (!taskMeta) { throw new Error('invalid/missing current async task meta during prepare call'); }
  
  const task = taskMeta.task;
  if (!task) { throw new Error('unexpectedly missing task in task meta during prepare call'); }
  
  const subtask = task.currentSubtask();
  if (!subtask) { throw new Error('invalid/missing subtask during async start call'); }
  
  return Number(subtask.waitableRep()) << 4 | subtask.getStateNumber();
}

function syncStartCall(callbackIdx) {
  _debugLog('[syncStartCall()] args', { callbackIdx });
}

if (!Promise.withResolvers) {
  Promise.withResolvers = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const _debugLog = (...args) => {
  if (!globalThis?.process?.env?.JCO_DEBUG) { return; }
  console.debug(...args);
}
const ASYNC_DETERMINISM = 'random';
const _coinFlip = () => { return Math.random() > 0.5; };
const I32_MAX = 2_147_483_647;
const I32_MIN = -2_147_483_648;
const _typeCheckValidI32 = (n) => typeof n === 'number' && n >= I32_MIN && n <= I32_MAX;

const base64Compile = str => WebAssembly.compile(typeof Buffer !== 'undefined' ? Buffer.from(str, 'base64') : Uint8Array.from(atob(str), b => b.charCodeAt(0)));

function clampGuest(i, min, max) {
  if (i < min || i > max) throw new TypeError(`must be between ${min} and ${max}`);
  return i;
}

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
let _fs;
async function fetchCompile (url) {
  if (isNode) {
    _fs = _fs || await import('node:fs/promises');
    return WebAssembly.compile(await _fs.readFile(url));
  }
  return fetch(url).then(WebAssembly.compileStreaming);
}

const symbolCabiDispose = Symbol.for('cabiDispose');

const symbolRscHandle = Symbol('handle');

const symbolRscRep = Symbol.for('cabiRep');

const symbolDispose = Symbol.dispose || Symbol.for('dispose');

const handleTables = [];

class ComponentError extends Error {
  constructor (value) {
    const enumerable = typeof value !== 'string';
    super(enumerable ? `${String(value)} (see error.payload)` : value);
    Object.defineProperty(this, 'payload', { value, enumerable });
  }
}

function getErrorPayload(e) {
  if (e && hasOwnProperty.call(e, 'payload')) return e.payload;
  if (e instanceof Error) throw e;
  return e;
}

class RepTable {
  #data = [0, null];
  
  insert(val) {
    _debugLog('[RepTable#insert()] args', { val });
    const freeIdx = this.#data[0];
    if (freeIdx === 0) {
      this.#data.push(val);
      this.#data.push(null);
      return (this.#data.length >> 1) - 1;
    }
    this.#data[0] = this.#data[freeIdx << 1];
    const placementIdx = freeIdx << 1;
    this.#data[placementIdx] = val;
    this.#data[placementIdx + 1] = null;
    return freeIdx;
  }
  
  get(rep) {
    _debugLog('[RepTable#get()] args', { rep });
    const baseIdx = rep << 1;
    const val = this.#data[baseIdx];
    return val;
  }
  
  contains(rep) {
    _debugLog('[RepTable#contains()] args', { rep });
    const baseIdx = rep << 1;
    return !!this.#data[baseIdx];
  }
  
  remove(rep) {
    _debugLog('[RepTable#remove()] args', { rep });
    if (this.#data.length === 2) { throw new Error('invalid'); }
    
    const baseIdx = rep << 1;
    const val = this.#data[baseIdx];
    if (val === 0) { throw new Error('invalid resource rep (cannot be 0)'); }
    
    this.#data[baseIdx] = this.#data[0];
    this.#data[0] = rep;
    
    return val;
  }
  
  clear() {
    _debugLog('[RepTable#clear()] args', { rep });
    this.#data = [0, null];
  }
}

function throwUninitialized() {
  throw new TypeError('Wasm uninitialized use `await $init` first');
}

const hasOwnProperty = Object.prototype.hasOwnProperty;

const instantiateCore = WebAssembly.instantiate;


let exports0;
const handleTable15 = [T_FLAG, 0];
const captureTable15= new Map();
let captureCnt15 = 0;
handleTables[15] = handleTable15;
const handleTable0 = [T_FLAG, 0];
const captureTable0= new Map();
let captureCnt0 = 0;
handleTables[0] = handleTable0;

function trampoline0(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable15[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable15.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(LazyProcess.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.get-ready-pollable"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]lazy-process.get-ready-pollable');
  const ret = rsc0.getReadyPollable();
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.get-ready-pollable"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  if (!(ret instanceof Pollable)) {
    throw new TypeError('Resource error: Not a valid "Pollable" resource.');
  }
  var handle3 = ret[symbolRscHandle];
  if (!handle3) {
    const rep = ret[symbolRscRep] || ++captureCnt0;
    captureTable0.set(rep, ret);
    handle3 = rscTableCreateOwn(handleTable0, rep);
  }
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.get-ready-pollable"][Instruction::Return]', {
    funcName: '[method]lazy-process.get-ready-pollable',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle3;
}


function trampoline1(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable15[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable15.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(LazyProcess.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.is-ready"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]lazy-process.is-ready');
  const ret = rsc0.isReady();
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.is-ready"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.is-ready"][Instruction::Return]', {
    funcName: '[method]lazy-process.is-ready',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return ret ? 1 : 0;
}


function trampoline2(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable15[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable15.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(LazyProcess.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.close-stdin"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]lazy-process.close-stdin');
  rsc0.closeStdin();
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.close-stdin"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.close-stdin"][Instruction::Return]', {
    funcName: '[method]lazy-process.close-stdin',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline4() {
  _debugLog('[iface="wasi:random/random@0.2.6", function="get-random-u64"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-random-u64');
  const ret = getRandomU64();
  _debugLog('[iface="wasi:random/random@0.2.6", function="get-random-u64"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  _debugLog('[iface="wasi:random/random@0.2.6", function="get-random-u64"][Instruction::Return]', {
    funcName: 'get-random-u64',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return toUint64(ret);
}

const handleTable4 = [T_FLAG, 0];
const captureTable4= new Map();
let captureCnt4 = 0;
handleTables[4] = handleTable4;

function trampoline5() {
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]fields"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[constructor]fields');
  const ret = new Fields();
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]fields"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof Fields)) {
    throw new TypeError('Resource error: Not a valid "Fields" resource.');
  }
  var handle0 = ret[symbolRscHandle];
  if (!handle0) {
    const rep = ret[symbolRscRep] || ++captureCnt4;
    captureTable4.set(rep, ret);
    handle0 = rscTableCreateOwn(handleTable4, rep);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]fields"][Instruction::Return]', {
    funcName: '[constructor]fields',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle0;
}

const handleTable5 = [T_FLAG, 0];
const captureTable5= new Map();
let captureCnt5 = 0;
handleTables[5] = handleTable5;

function trampoline6(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Fields.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  else {
    captureTable4.delete(rep2);
  }
  rscTableRemove(handleTable4, handle1);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]outgoing-request"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[constructor]outgoing-request');
  const ret = new OutgoingRequest(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]outgoing-request"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof OutgoingRequest)) {
    throw new TypeError('Resource error: Not a valid "OutgoingRequest" resource.');
  }
  var handle3 = ret[symbolRscHandle];
  if (!handle3) {
    const rep = ret[symbolRscRep] || ++captureCnt5;
    captureTable5.set(rep, ret);
    handle3 = rscTableCreateOwn(handleTable5, rep);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]outgoing-request"][Instruction::Return]', {
    funcName: '[constructor]outgoing-request',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle3;
}

const handleTable3 = [T_FLAG, 0];
const captureTable3= new Map();
let captureCnt3 = 0;
handleTables[3] = handleTable3;

function trampoline7(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.subscribe"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]output-stream.subscribe');
  const ret = rsc0.subscribe();
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.subscribe"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  if (!(ret instanceof Pollable)) {
    throw new TypeError('Resource error: Not a valid "Pollable" resource.');
  }
  var handle3 = ret[symbolRscHandle];
  if (!handle3) {
    const rep = ret[symbolRscRep] || ++captureCnt0;
    captureTable0.set(rep, ret);
    handle3 = rscTableCreateOwn(handleTable0, rep);
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.subscribe"][Instruction::Return]', {
    funcName: '[method]output-stream.subscribe',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle3;
}

const handleTable8 = [T_FLAG, 0];
const captureTable8= new Map();
let captureCnt8 = 0;
handleTables[8] = handleTable8;

function trampoline8(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(IncomingResponse.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.status"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]incoming-response.status');
  const ret = rsc0.status();
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.status"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.status"][Instruction::Return]', {
    funcName: '[method]incoming-response.status',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return toUint16(ret);
}

const handleTable2 = [T_FLAG, 0];
const captureTable2= new Map();
let captureCnt2 = 0;
handleTables[2] = handleTable2;

function trampoline9(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable2.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(InputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.subscribe"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]input-stream.subscribe');
  const ret = rsc0.subscribe();
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.subscribe"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  if (!(ret instanceof Pollable)) {
    throw new TypeError('Resource error: Not a valid "Pollable" resource.');
  }
  var handle3 = ret[symbolRscHandle];
  if (!handle3) {
    const rep = ret[symbolRscRep] || ++captureCnt0;
    captureTable0.set(rep, ret);
    handle3 = rscTableCreateOwn(handleTable0, rep);
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.subscribe"][Instruction::Return]', {
    funcName: '[method]input-stream.subscribe',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle3;
}


function trampoline12(arg0) {
  _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.6", function="subscribe-duration"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'subscribe-duration');
  const ret = subscribeDuration(BigInt.asUintN(64, arg0));
  _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.6", function="subscribe-duration"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof Pollable)) {
    throw new TypeError('Resource error: Not a valid "Pollable" resource.');
  }
  var handle0 = ret[symbolRscHandle];
  if (!handle0) {
    const rep = ret[symbolRscRep] || ++captureCnt0;
    captureTable0.set(rep, ret);
    handle0 = rscTableCreateOwn(handleTable0, rep);
  }
  _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.6", function="subscribe-duration"][Instruction::Return]', {
    funcName: 'subscribe-duration',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle0;
}


function trampoline13(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable0.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Pollable.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/poll@0.2.6", function="[method]pollable.block"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]pollable.block');
  rsc0.block();
  _debugLog('[iface="wasi:io/poll@0.2.6", function="[method]pollable.block"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  _debugLog('[iface="wasi:io/poll@0.2.6", function="[method]pollable.block"][Instruction::Return]', {
    funcName: '[method]pollable.block',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

const handleTable10 = [T_FLAG, 0];
const captureTable10= new Map();
let captureCnt10 = 0;
handleTables[10] = handleTable10;

function trampoline22(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable10[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable10.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(IncomingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-request.headers"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]incoming-request.headers');
  const ret = rsc0.headers();
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-request.headers"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  if (!(ret instanceof Fields)) {
    throw new TypeError('Resource error: Not a valid "Headers" resource.');
  }
  var handle3 = ret[symbolRscHandle];
  if (!handle3) {
    const rep = ret[symbolRscRep] || ++captureCnt4;
    captureTable4.set(rep, ret);
    handle3 = rscTableCreateOwn(handleTable4, rep);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-request.headers"][Instruction::Return]', {
    funcName: '[method]incoming-request.headers',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle3;
}

const handleTable9 = [T_FLAG, 0];
const captureTable9= new Map();
let captureCnt9 = 0;
handleTables[9] = handleTable9;
const handleTable11 = [T_FLAG, 0];
const captureTable11= new Map();
let captureCnt11 = 0;
handleTables[11] = handleTable11;

function trampoline23(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(IncomingBody.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  else {
    captureTable9.delete(rep2);
  }
  rscTableRemove(handleTable9, handle1);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[static]incoming-body.finish"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[static]incoming-body.finish');
  const ret = IncomingBody.finish(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[static]incoming-body.finish"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof FutureTrailers)) {
    throw new TypeError('Resource error: Not a valid "FutureTrailers" resource.');
  }
  var handle3 = ret[symbolRscHandle];
  if (!handle3) {
    const rep = ret[symbolRscRep] || ++captureCnt11;
    captureTable11.set(rep, ret);
    handle3 = rscTableCreateOwn(handleTable11, rep);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[static]incoming-body.finish"][Instruction::Return]', {
    funcName: '[static]incoming-body.finish',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle3;
}

const handleTable12 = [T_FLAG, 0];
const captureTable12= new Map();
let captureCnt12 = 0;
handleTables[12] = handleTable12;

function trampoline25(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Fields.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  else {
    captureTable4.delete(rep2);
  }
  rscTableRemove(handleTable4, handle1);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]outgoing-response"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[constructor]outgoing-response');
  const ret = new OutgoingResponse(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]outgoing-response"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof OutgoingResponse)) {
    throw new TypeError('Resource error: Not a valid "OutgoingResponse" resource.');
  }
  var handle3 = ret[symbolRscHandle];
  if (!handle3) {
    const rep = ret[symbolRscRep] || ++captureCnt12;
    captureTable12.set(rep, ret);
    handle3 = rscTableCreateOwn(handleTable12, rep);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]outgoing-response"][Instruction::Return]', {
    funcName: '[constructor]outgoing-response',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle3;
}


function trampoline26(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable12[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable12.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingResponse.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-response.set-status-code"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]outgoing-response.set-status-code');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.setStatusCode(clampGuest(arg1, 0, 65535))};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-response.set-status-code"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant3 = ret;
  let variant3_0;
  switch (variant3.tag) {
    case 'ok': {
      const e = variant3.val;
      variant3_0 = 0;
      break;
    }
    case 'err': {
      const e = variant3.val;
      variant3_0 = 1;
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-response.set-status-code"][Instruction::Return]', {
    funcName: '[method]outgoing-response.set-status-code',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return variant3_0;
}


function trampoline30() {
  _debugLog('[iface="wasi:cli/stdout@0.2.6", function="get-stdout"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-stdout');
  const ret = getStdout();
  _debugLog('[iface="wasi:cli/stdout@0.2.6", function="get-stdout"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof OutputStream)) {
    throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
  }
  var handle0 = ret[symbolRscHandle];
  if (!handle0) {
    const rep = ret[symbolRscRep] || ++captureCnt3;
    captureTable3.set(rep, ret);
    handle0 = rscTableCreateOwn(handleTable3, rep);
  }
  _debugLog('[iface="wasi:cli/stdout@0.2.6", function="get-stdout"][Instruction::Return]', {
    funcName: 'get-stdout',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle0;
}


function trampoline31() {
  _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.6", function="now"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'now');
  const ret = now();
  _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.6", function="now"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.6", function="now"][Instruction::Return]', {
    funcName: 'now',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return toUint64(ret);
}


function trampoline32() {
  _debugLog('[iface="wasi:cli/stderr@0.2.6", function="get-stderr"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-stderr');
  const ret = getStderr();
  _debugLog('[iface="wasi:cli/stderr@0.2.6", function="get-stderr"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof OutputStream)) {
    throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
  }
  var handle0 = ret[symbolRscHandle];
  if (!handle0) {
    const rep = ret[symbolRscRep] || ++captureCnt3;
    captureTable3.set(rep, ret);
    handle0 = rscTableCreateOwn(handleTable3, rep);
  }
  _debugLog('[iface="wasi:cli/stderr@0.2.6", function="get-stderr"][Instruction::Return]', {
    funcName: 'get-stderr',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle0;
}

let exports1;

function trampoline41() {
  _debugLog('[iface="wasi:cli/stdin@0.2.6", function="get-stdin"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-stdin');
  const ret = getStdin();
  _debugLog('[iface="wasi:cli/stdin@0.2.6", function="get-stdin"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof InputStream)) {
    throw new TypeError('Resource error: Not a valid "InputStream" resource.');
  }
  var handle0 = ret[symbolRscHandle];
  if (!handle0) {
    const rep = ret[symbolRscRep] || ++captureCnt2;
    captureTable2.set(rep, ret);
    handle0 = rscTableCreateOwn(handleTable2, rep);
  }
  _debugLog('[iface="wasi:cli/stdin@0.2.6", function="get-stdin"][Instruction::Return]', {
    funcName: 'get-stdin',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle0;
}


function trampoline42(arg0) {
  let variant0;
  if (arg0) {
    variant0= {
      tag: 'err',
      val: undefined
    };
  } else {
    variant0= {
      tag: 'ok',
      val: undefined
    };
  }
  _debugLog('[iface="wasi:cli/exit@0.2.6", function="exit"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'exit');
  exit(variant0);
  _debugLog('[iface="wasi:cli/exit@0.2.6", function="exit"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  _debugLog('[iface="wasi:cli/exit@0.2.6", function="exit"][Instruction::Return]', {
    funcName: 'exit',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

let exports2;
let memory0;
let realloc0;
let realloc1;

function trampoline43(arg0, arg1, arg2) {
  var ptr0 = arg0;
  var len0 = arg1;
  var result0 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr0, len0));
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="get-lazy-module"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-lazy-module');
  const ret = getLazyModule(result0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="get-lazy-module"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var variant2 = ret;
  if (variant2 === null || variant2=== undefined) {
    dataView(memory0).setInt8(arg2 + 0, 0, true);
  } else {
    const e = variant2;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var ptr1 = utf8Encode(e, realloc0, memory0);
    var len1 = utf8EncodedLen;
    dataView(memory0).setUint32(arg2 + 8, len1, true);
    dataView(memory0).setUint32(arg2 + 4, ptr1, true);
  }
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="get-lazy-module"][Instruction::Return]', {
    funcName: 'get-lazy-module',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline44(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
  var ptr0 = arg0;
  var len0 = arg1;
  var result0 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr0, len0));
  var ptr1 = arg2;
  var len1 = arg3;
  var result1 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr1, len1));
  var len3 = arg5;
  var base3 = arg4;
  var result3 = [];
  for (let i = 0; i < len3; i++) {
    const base = base3 + i * 8;
    var ptr2 = dataView(memory0).getUint32(base + 0, true);
    var len2 = dataView(memory0).getUint32(base + 4, true);
    var result2 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr2, len2));
    result3.push(result2);
  }
  var ptr4 = arg6;
  var len4 = arg7;
  var result4 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr4, len4));
  var len7 = arg9;
  var base7 = arg8;
  var result7 = [];
  for (let i = 0; i < len7; i++) {
    const base = base7 + i * 16;
    var ptr5 = dataView(memory0).getUint32(base + 0, true);
    var len5 = dataView(memory0).getUint32(base + 4, true);
    var result5 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr5, len5));
    var ptr6 = dataView(memory0).getUint32(base + 8, true);
    var len6 = dataView(memory0).getUint32(base + 12, true);
    var result6 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr6, len6));
    result7.push([result5, result6]);
  }
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="spawn-lazy-command"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'spawn-lazy-command');
  const ret = spawnLazyCommand(result0, result1, result3, {
    cwd: result4,
    vars: result7,
  });
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="spawn-lazy-command"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof LazyProcess)) {
    throw new TypeError('Resource error: Not a valid "LazyProcess" resource.');
  }
  var handle8 = ret[symbolRscHandle];
  if (!handle8) {
    const rep = ret[symbolRscRep] || ++captureCnt15;
    captureTable15.set(rep, ret);
    handle8 = rscTableCreateOwn(handleTable15, rep);
  }
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="spawn-lazy-command"][Instruction::Return]', {
    funcName: 'spawn-lazy-command',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle8;
}


function trampoline45(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable15[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable15.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(LazyProcess.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.write-stdin"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]lazy-process.write-stdin');
  const ret = rsc0.writeStdin(result3);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.write-stdin"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.write-stdin"][Instruction::Return]', {
    funcName: '[method]lazy-process.write-stdin',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return toUint64(ret);
}


function trampoline46(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable15[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable15.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(LazyProcess.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.try-wait"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]lazy-process.try-wait');
  const ret = rsc0.tryWait();
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.try-wait"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant3 = ret;
  if (variant3 === null || variant3=== undefined) {
    dataView(memory0).setInt8(arg1 + 0, 0, true);
  } else {
    const e = variant3;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    dataView(memory0).setInt32(arg1 + 4, toInt32(e), true);
  }
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.try-wait"][Instruction::Return]', {
    funcName: '[method]lazy-process.try-wait',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline47(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable15[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable15.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(LazyProcess.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.read-stderr"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]lazy-process.read-stderr');
  const ret = rsc0.readStderr(BigInt.asUintN(64, arg1));
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.read-stderr"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var val3 = ret;
  var len3 = val3.byteLength;
  var ptr3 = realloc0(0, 0, 1, len3 * 1);
  var src3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, len3 * 1);
  (new Uint8Array(memory0.buffer, ptr3, len3 * 1)).set(src3);
  dataView(memory0).setUint32(arg2 + 4, len3, true);
  dataView(memory0).setUint32(arg2 + 0, ptr3, true);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.read-stderr"][Instruction::Return]', {
    funcName: '[method]lazy-process.read-stderr',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline48(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable15[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable15.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(LazyProcess.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.read-stdout"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]lazy-process.read-stdout');
  const ret = rsc0.readStdout(BigInt.asUintN(64, arg1));
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.read-stdout"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var val3 = ret;
  var len3 = val3.byteLength;
  var ptr3 = realloc0(0, 0, 1, len3 * 1);
  var src3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, len3 * 1);
  (new Uint8Array(memory0.buffer, ptr3, len3 * 1)).set(src3);
  dataView(memory0).setUint32(arg2 + 4, len3, true);
  dataView(memory0).setUint32(arg2 + 0, ptr3, true);
  _debugLog('[iface="mcp:module-loader/loader@0.1.0", function="[method]lazy-process.read-stdout"][Instruction::Return]', {
    funcName: '[method]lazy-process.read-stdout',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline49(arg0, arg1) {
  _debugLog('[iface="wasi:random/random@0.2.6", function="get-random-bytes"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-random-bytes');
  const ret = getRandomBytes(BigInt.asUintN(64, arg0));
  _debugLog('[iface="wasi:random/random@0.2.6", function="get-random-bytes"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var val0 = ret;
  var len0 = val0.byteLength;
  var ptr0 = realloc0(0, 0, 1, len0 * 1);
  var src0 = new Uint8Array(val0.buffer || val0, val0.byteOffset, len0 * 1);
  (new Uint8Array(memory0.buffer, ptr0, len0 * 1)).set(src0);
  dataView(memory0).setUint32(arg1 + 4, len0, true);
  dataView(memory0).setUint32(arg1 + 0, ptr0, true);
  _debugLog('[iface="wasi:random/random@0.2.6", function="get-random-bytes"][Instruction::Return]', {
    funcName: 'get-random-bytes',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline50(arg0, arg1, arg2, arg3, arg4, arg5) {
  var handle1 = arg0;
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Fields.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
  var ptr4 = arg3;
  var len4 = arg4;
  var result4 = new Uint8Array(memory0.buffer.slice(ptr4, ptr4 + len4 * 1));
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]fields.append"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]fields.append');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.append(result3, result4)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]fields.append"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg5 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg5 + 0, 1, true);
      var variant5 = e;
      switch (variant5.tag) {
        case 'invalid-syntax': {
          dataView(memory0).setInt8(arg5 + 1, 0, true);
          break;
        }
        case 'forbidden': {
          dataView(memory0).setInt8(arg5 + 1, 1, true);
          break;
        }
        case 'immutable': {
          dataView(memory0).setInt8(arg5 + 1, 2, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`HeaderError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]fields.append"][Instruction::Return]', {
    funcName: '[method]fields.append',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline51(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable5[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable5.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  let variant4;
  switch (arg1) {
    case 0: {
      variant4= {
        tag: 'get',
      };
      break;
    }
    case 1: {
      variant4= {
        tag: 'head',
      };
      break;
    }
    case 2: {
      variant4= {
        tag: 'post',
      };
      break;
    }
    case 3: {
      variant4= {
        tag: 'put',
      };
      break;
    }
    case 4: {
      variant4= {
        tag: 'delete',
      };
      break;
    }
    case 5: {
      variant4= {
        tag: 'connect',
      };
      break;
    }
    case 6: {
      variant4= {
        tag: 'options',
      };
      break;
    }
    case 7: {
      variant4= {
        tag: 'trace',
      };
      break;
    }
    case 8: {
      variant4= {
        tag: 'patch',
      };
      break;
    }
    case 9: {
      var ptr3 = arg2;
      var len3 = arg3;
      var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
      variant4= {
        tag: 'other',
        val: result3
      };
      break;
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-method"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]outgoing-request.set-method');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.setMethod(variant4)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-method"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  let variant5_0;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      variant5_0 = 0;
      break;
    }
    case 'err': {
      const e = variant5.val;
      variant5_0 = 1;
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-method"][Instruction::Return]', {
    funcName: '[method]outgoing-request.set-method',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return variant5_0;
}


function trampoline52(arg0, arg1, arg2, arg3, arg4) {
  var handle1 = arg0;
  var rep2 = handleTable5[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable5.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  let variant5;
  if (arg1) {
    let variant4;
    switch (arg2) {
      case 0: {
        variant4= {
          tag: 'HTTP',
        };
        break;
      }
      case 1: {
        variant4= {
          tag: 'HTTPS',
        };
        break;
      }
      case 2: {
        var ptr3 = arg3;
        var len3 = arg4;
        var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
        variant4= {
          tag: 'other',
          val: result3
        };
        break;
      }
    }
    variant5 = variant4;
  } else {
    variant5 = undefined;
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-scheme"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]outgoing-request.set-scheme');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.setScheme(variant5)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-scheme"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  let variant6_0;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      variant6_0 = 0;
      break;
    }
    case 'err': {
      const e = variant6.val;
      variant6_0 = 1;
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-scheme"][Instruction::Return]', {
    funcName: '[method]outgoing-request.set-scheme',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return variant6_0;
}


function trampoline53(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable5[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable5.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  let variant4;
  if (arg1) {
    var ptr3 = arg2;
    var len3 = arg3;
    var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
    variant4 = result3;
  } else {
    variant4 = undefined;
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-authority"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]outgoing-request.set-authority');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.setAuthority(variant4)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-authority"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  let variant5_0;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      variant5_0 = 0;
      break;
    }
    case 'err': {
      const e = variant5.val;
      variant5_0 = 1;
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-authority"][Instruction::Return]', {
    funcName: '[method]outgoing-request.set-authority',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return variant5_0;
}


function trampoline54(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable5[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable5.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  let variant4;
  if (arg1) {
    var ptr3 = arg2;
    var len3 = arg3;
    var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
    variant4 = result3;
  } else {
    variant4 = undefined;
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-path-with-query"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]outgoing-request.set-path-with-query');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.setPathWithQuery(variant4)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-path-with-query"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  let variant5_0;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      variant5_0 = 0;
      break;
    }
    case 'err': {
      const e = variant5.val;
      variant5_0 = 1;
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.set-path-with-query"][Instruction::Return]', {
    funcName: '[method]outgoing-request.set-path-with-query',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return variant5_0;
}

const handleTable6 = [T_FLAG, 0];
const captureTable6= new Map();
let captureCnt6 = 0;
handleTables[6] = handleTable6;

function trampoline55(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable5[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable5.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.body"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]outgoing-request.body');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.body()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.body"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant4 = ret;
  switch (variant4.tag) {
    case 'ok': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      if (!(e instanceof OutgoingBody)) {
        throw new TypeError('Resource error: Not a valid "OutgoingBody" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt6;
        captureTable6.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable6, rep);
      }
      dataView(memory0).setInt32(arg1 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.body"][Instruction::Return]', {
    funcName: '[method]outgoing-request.body',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

const handleTable7 = [T_FLAG, 0];
const captureTable7= new Map();
let captureCnt7 = 0;
handleTables[7] = handleTable7;

function trampoline56(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable7.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(FutureIncomingResponse.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]future-incoming-response.get"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]future-incoming-response.get');
  const ret = rsc0.get();
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]future-incoming-response.get"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant44 = ret;
  if (variant44 === null || variant44=== undefined) {
    dataView(memory0).setInt8(arg1 + 0, 0, true);
  } else {
    const e = variant44;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var variant43 = e;
    switch (variant43.tag) {
      case 'ok': {
        const e = variant43.val;
        dataView(memory0).setInt8(arg1 + 8, 0, true);
        var variant42 = e;
        switch (variant42.tag) {
          case 'ok': {
            const e = variant42.val;
            dataView(memory0).setInt8(arg1 + 16, 0, true);
            if (!(e instanceof IncomingResponse)) {
              throw new TypeError('Resource error: Not a valid "IncomingResponse" resource.');
            }
            var handle3 = e[symbolRscHandle];
            if (!handle3) {
              const rep = e[symbolRscRep] || ++captureCnt8;
              captureTable8.set(rep, e);
              handle3 = rscTableCreateOwn(handleTable8, rep);
            }
            dataView(memory0).setInt32(arg1 + 24, handle3, true);
            break;
          }
          case 'err': {
            const e = variant42.val;
            dataView(memory0).setInt8(arg1 + 16, 1, true);
            var variant41 = e;
            switch (variant41.tag) {
              case 'DNS-timeout': {
                dataView(memory0).setInt8(arg1 + 24, 0, true);
                break;
              }
              case 'DNS-error': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 1, true);
                var {rcode: v4_0, infoCode: v4_1 } = e;
                var variant6 = v4_0;
                if (variant6 === null || variant6=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant6;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  var ptr5 = utf8Encode(e, realloc0, memory0);
                  var len5 = utf8EncodedLen;
                  dataView(memory0).setUint32(arg1 + 40, len5, true);
                  dataView(memory0).setUint32(arg1 + 36, ptr5, true);
                }
                var variant7 = v4_1;
                if (variant7 === null || variant7=== undefined) {
                  dataView(memory0).setInt8(arg1 + 44, 0, true);
                } else {
                  const e = variant7;
                  dataView(memory0).setInt8(arg1 + 44, 1, true);
                  dataView(memory0).setInt16(arg1 + 46, toUint16(e), true);
                }
                break;
              }
              case 'destination-not-found': {
                dataView(memory0).setInt8(arg1 + 24, 2, true);
                break;
              }
              case 'destination-unavailable': {
                dataView(memory0).setInt8(arg1 + 24, 3, true);
                break;
              }
              case 'destination-IP-prohibited': {
                dataView(memory0).setInt8(arg1 + 24, 4, true);
                break;
              }
              case 'destination-IP-unroutable': {
                dataView(memory0).setInt8(arg1 + 24, 5, true);
                break;
              }
              case 'connection-refused': {
                dataView(memory0).setInt8(arg1 + 24, 6, true);
                break;
              }
              case 'connection-terminated': {
                dataView(memory0).setInt8(arg1 + 24, 7, true);
                break;
              }
              case 'connection-timeout': {
                dataView(memory0).setInt8(arg1 + 24, 8, true);
                break;
              }
              case 'connection-read-timeout': {
                dataView(memory0).setInt8(arg1 + 24, 9, true);
                break;
              }
              case 'connection-write-timeout': {
                dataView(memory0).setInt8(arg1 + 24, 10, true);
                break;
              }
              case 'connection-limit-reached': {
                dataView(memory0).setInt8(arg1 + 24, 11, true);
                break;
              }
              case 'TLS-protocol-error': {
                dataView(memory0).setInt8(arg1 + 24, 12, true);
                break;
              }
              case 'TLS-certificate-error': {
                dataView(memory0).setInt8(arg1 + 24, 13, true);
                break;
              }
              case 'TLS-alert-received': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 14, true);
                var {alertId: v8_0, alertMessage: v8_1 } = e;
                var variant9 = v8_0;
                if (variant9 === null || variant9=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant9;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  dataView(memory0).setInt8(arg1 + 33, toUint8(e), true);
                }
                var variant11 = v8_1;
                if (variant11 === null || variant11=== undefined) {
                  dataView(memory0).setInt8(arg1 + 36, 0, true);
                } else {
                  const e = variant11;
                  dataView(memory0).setInt8(arg1 + 36, 1, true);
                  var ptr10 = utf8Encode(e, realloc0, memory0);
                  var len10 = utf8EncodedLen;
                  dataView(memory0).setUint32(arg1 + 44, len10, true);
                  dataView(memory0).setUint32(arg1 + 40, ptr10, true);
                }
                break;
              }
              case 'HTTP-request-denied': {
                dataView(memory0).setInt8(arg1 + 24, 15, true);
                break;
              }
              case 'HTTP-request-length-required': {
                dataView(memory0).setInt8(arg1 + 24, 16, true);
                break;
              }
              case 'HTTP-request-body-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 17, true);
                var variant12 = e;
                if (variant12 === null || variant12=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant12;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  dataView(memory0).setBigInt64(arg1 + 40, toUint64(e), true);
                }
                break;
              }
              case 'HTTP-request-method-invalid': {
                dataView(memory0).setInt8(arg1 + 24, 18, true);
                break;
              }
              case 'HTTP-request-URI-invalid': {
                dataView(memory0).setInt8(arg1 + 24, 19, true);
                break;
              }
              case 'HTTP-request-URI-too-long': {
                dataView(memory0).setInt8(arg1 + 24, 20, true);
                break;
              }
              case 'HTTP-request-header-section-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 21, true);
                var variant13 = e;
                if (variant13 === null || variant13=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant13;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  dataView(memory0).setInt32(arg1 + 36, toUint32(e), true);
                }
                break;
              }
              case 'HTTP-request-header-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 22, true);
                var variant18 = e;
                if (variant18 === null || variant18=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant18;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  var {fieldName: v14_0, fieldSize: v14_1 } = e;
                  var variant16 = v14_0;
                  if (variant16 === null || variant16=== undefined) {
                    dataView(memory0).setInt8(arg1 + 36, 0, true);
                  } else {
                    const e = variant16;
                    dataView(memory0).setInt8(arg1 + 36, 1, true);
                    var ptr15 = utf8Encode(e, realloc0, memory0);
                    var len15 = utf8EncodedLen;
                    dataView(memory0).setUint32(arg1 + 44, len15, true);
                    dataView(memory0).setUint32(arg1 + 40, ptr15, true);
                  }
                  var variant17 = v14_1;
                  if (variant17 === null || variant17=== undefined) {
                    dataView(memory0).setInt8(arg1 + 48, 0, true);
                  } else {
                    const e = variant17;
                    dataView(memory0).setInt8(arg1 + 48, 1, true);
                    dataView(memory0).setInt32(arg1 + 52, toUint32(e), true);
                  }
                }
                break;
              }
              case 'HTTP-request-trailer-section-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 23, true);
                var variant19 = e;
                if (variant19 === null || variant19=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant19;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  dataView(memory0).setInt32(arg1 + 36, toUint32(e), true);
                }
                break;
              }
              case 'HTTP-request-trailer-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 24, true);
                var {fieldName: v20_0, fieldSize: v20_1 } = e;
                var variant22 = v20_0;
                if (variant22 === null || variant22=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant22;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  var ptr21 = utf8Encode(e, realloc0, memory0);
                  var len21 = utf8EncodedLen;
                  dataView(memory0).setUint32(arg1 + 40, len21, true);
                  dataView(memory0).setUint32(arg1 + 36, ptr21, true);
                }
                var variant23 = v20_1;
                if (variant23 === null || variant23=== undefined) {
                  dataView(memory0).setInt8(arg1 + 44, 0, true);
                } else {
                  const e = variant23;
                  dataView(memory0).setInt8(arg1 + 44, 1, true);
                  dataView(memory0).setInt32(arg1 + 48, toUint32(e), true);
                }
                break;
              }
              case 'HTTP-response-incomplete': {
                dataView(memory0).setInt8(arg1 + 24, 25, true);
                break;
              }
              case 'HTTP-response-header-section-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 26, true);
                var variant24 = e;
                if (variant24 === null || variant24=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant24;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  dataView(memory0).setInt32(arg1 + 36, toUint32(e), true);
                }
                break;
              }
              case 'HTTP-response-header-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 27, true);
                var {fieldName: v25_0, fieldSize: v25_1 } = e;
                var variant27 = v25_0;
                if (variant27 === null || variant27=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant27;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  var ptr26 = utf8Encode(e, realloc0, memory0);
                  var len26 = utf8EncodedLen;
                  dataView(memory0).setUint32(arg1 + 40, len26, true);
                  dataView(memory0).setUint32(arg1 + 36, ptr26, true);
                }
                var variant28 = v25_1;
                if (variant28 === null || variant28=== undefined) {
                  dataView(memory0).setInt8(arg1 + 44, 0, true);
                } else {
                  const e = variant28;
                  dataView(memory0).setInt8(arg1 + 44, 1, true);
                  dataView(memory0).setInt32(arg1 + 48, toUint32(e), true);
                }
                break;
              }
              case 'HTTP-response-body-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 28, true);
                var variant29 = e;
                if (variant29 === null || variant29=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant29;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  dataView(memory0).setBigInt64(arg1 + 40, toUint64(e), true);
                }
                break;
              }
              case 'HTTP-response-trailer-section-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 29, true);
                var variant30 = e;
                if (variant30 === null || variant30=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant30;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  dataView(memory0).setInt32(arg1 + 36, toUint32(e), true);
                }
                break;
              }
              case 'HTTP-response-trailer-size': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 30, true);
                var {fieldName: v31_0, fieldSize: v31_1 } = e;
                var variant33 = v31_0;
                if (variant33 === null || variant33=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant33;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  var ptr32 = utf8Encode(e, realloc0, memory0);
                  var len32 = utf8EncodedLen;
                  dataView(memory0).setUint32(arg1 + 40, len32, true);
                  dataView(memory0).setUint32(arg1 + 36, ptr32, true);
                }
                var variant34 = v31_1;
                if (variant34 === null || variant34=== undefined) {
                  dataView(memory0).setInt8(arg1 + 44, 0, true);
                } else {
                  const e = variant34;
                  dataView(memory0).setInt8(arg1 + 44, 1, true);
                  dataView(memory0).setInt32(arg1 + 48, toUint32(e), true);
                }
                break;
              }
              case 'HTTP-response-transfer-coding': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 31, true);
                var variant36 = e;
                if (variant36 === null || variant36=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant36;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  var ptr35 = utf8Encode(e, realloc0, memory0);
                  var len35 = utf8EncodedLen;
                  dataView(memory0).setUint32(arg1 + 40, len35, true);
                  dataView(memory0).setUint32(arg1 + 36, ptr35, true);
                }
                break;
              }
              case 'HTTP-response-content-coding': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 32, true);
                var variant38 = e;
                if (variant38 === null || variant38=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant38;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  var ptr37 = utf8Encode(e, realloc0, memory0);
                  var len37 = utf8EncodedLen;
                  dataView(memory0).setUint32(arg1 + 40, len37, true);
                  dataView(memory0).setUint32(arg1 + 36, ptr37, true);
                }
                break;
              }
              case 'HTTP-response-timeout': {
                dataView(memory0).setInt8(arg1 + 24, 33, true);
                break;
              }
              case 'HTTP-upgrade-failed': {
                dataView(memory0).setInt8(arg1 + 24, 34, true);
                break;
              }
              case 'HTTP-protocol-error': {
                dataView(memory0).setInt8(arg1 + 24, 35, true);
                break;
              }
              case 'loop-detected': {
                dataView(memory0).setInt8(arg1 + 24, 36, true);
                break;
              }
              case 'configuration-error': {
                dataView(memory0).setInt8(arg1 + 24, 37, true);
                break;
              }
              case 'internal-error': {
                const e = variant41.val;
                dataView(memory0).setInt8(arg1 + 24, 38, true);
                var variant40 = e;
                if (variant40 === null || variant40=== undefined) {
                  dataView(memory0).setInt8(arg1 + 32, 0, true);
                } else {
                  const e = variant40;
                  dataView(memory0).setInt8(arg1 + 32, 1, true);
                  var ptr39 = utf8Encode(e, realloc0, memory0);
                  var len39 = utf8EncodedLen;
                  dataView(memory0).setUint32(arg1 + 40, len39, true);
                  dataView(memory0).setUint32(arg1 + 36, ptr39, true);
                }
                break;
              }
              default: {
                throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant41.tag)}\` (received \`${variant41}\`) specified for \`ErrorCode\``);
              }
            }
            break;
          }
          default: {
            throw new TypeError('invalid variant specified for result');
          }
        }
        break;
      }
      case 'err': {
        const e = variant43.val;
        dataView(memory0).setInt8(arg1 + 8, 1, true);
        break;
      }
      default: {
        throw new TypeError('invalid variant specified for result');
      }
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]future-incoming-response.get"][Instruction::Return]', {
    funcName: '[method]future-incoming-response.get',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline57(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(IncomingResponse.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.consume"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]incoming-response.consume');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.consume()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.consume"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant4 = ret;
  switch (variant4.tag) {
    case 'ok': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      if (!(e instanceof IncomingBody)) {
        throw new TypeError('Resource error: Not a valid "IncomingBody" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt9;
        captureTable9.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable9, rep);
      }
      dataView(memory0).setInt32(arg1 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.consume"][Instruction::Return]', {
    funcName: '[method]incoming-response.consume',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline58(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(IncomingBody.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-body.stream"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]incoming-body.stream');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.stream()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-body.stream"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant4 = ret;
  switch (variant4.tag) {
    case 'ok': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      if (!(e instanceof InputStream)) {
        throw new TypeError('Resource error: Not a valid "InputStream" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable2, rep);
      }
      dataView(memory0).setInt32(arg1 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-body.stream"][Instruction::Return]', {
    funcName: '[method]incoming-body.stream',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline59(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable6.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingBody.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-body.write"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]outgoing-body.write');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.write()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-body.write"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant4 = ret;
  switch (variant4.tag) {
    case 'ok': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      if (!(e instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt3;
        captureTable3.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable3, rep);
      }
      dataView(memory0).setInt32(arg1 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-body.write"][Instruction::Return]', {
    funcName: '[method]outgoing-body.write',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline60(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable6.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingBody.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  else {
    captureTable6.delete(rep2);
  }
  rscTableRemove(handleTable6, handle1);
  let variant6;
  if (arg1) {
    var handle4 = arg2;
    var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
    var rsc3 = captureTable4.get(rep5);
    if (!rsc3) {
      rsc3 = Object.create(Fields.prototype);
      Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
      Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
    }
    else {
      captureTable4.delete(rep5);
    }
    rscTableRemove(handleTable4, handle4);
    variant6 = rsc3;
  } else {
    variant6 = undefined;
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[static]outgoing-body.finish"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[static]outgoing-body.finish');
  let ret;
  try {
    ret = { tag: 'ok', val: OutgoingBody.finish(rsc0, variant6)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[static]outgoing-body.finish"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var variant45 = ret;
  switch (variant45.tag) {
    case 'ok': {
      const e = variant45.val;
      dataView(memory0).setInt8(arg3 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant45.val;
      dataView(memory0).setInt8(arg3 + 0, 1, true);
      var variant44 = e;
      switch (variant44.tag) {
        case 'DNS-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 0, true);
          break;
        }
        case 'DNS-error': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 1, true);
          var {rcode: v7_0, infoCode: v7_1 } = e;
          var variant9 = v7_0;
          if (variant9 === null || variant9=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant9;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr8 = utf8Encode(e, realloc0, memory0);
            var len8 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len8, true);
            dataView(memory0).setUint32(arg3 + 20, ptr8, true);
          }
          var variant10 = v7_1;
          if (variant10 === null || variant10=== undefined) {
            dataView(memory0).setInt8(arg3 + 28, 0, true);
          } else {
            const e = variant10;
            dataView(memory0).setInt8(arg3 + 28, 1, true);
            dataView(memory0).setInt16(arg3 + 30, toUint16(e), true);
          }
          break;
        }
        case 'destination-not-found': {
          dataView(memory0).setInt8(arg3 + 8, 2, true);
          break;
        }
        case 'destination-unavailable': {
          dataView(memory0).setInt8(arg3 + 8, 3, true);
          break;
        }
        case 'destination-IP-prohibited': {
          dataView(memory0).setInt8(arg3 + 8, 4, true);
          break;
        }
        case 'destination-IP-unroutable': {
          dataView(memory0).setInt8(arg3 + 8, 5, true);
          break;
        }
        case 'connection-refused': {
          dataView(memory0).setInt8(arg3 + 8, 6, true);
          break;
        }
        case 'connection-terminated': {
          dataView(memory0).setInt8(arg3 + 8, 7, true);
          break;
        }
        case 'connection-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 8, true);
          break;
        }
        case 'connection-read-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 9, true);
          break;
        }
        case 'connection-write-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 10, true);
          break;
        }
        case 'connection-limit-reached': {
          dataView(memory0).setInt8(arg3 + 8, 11, true);
          break;
        }
        case 'TLS-protocol-error': {
          dataView(memory0).setInt8(arg3 + 8, 12, true);
          break;
        }
        case 'TLS-certificate-error': {
          dataView(memory0).setInt8(arg3 + 8, 13, true);
          break;
        }
        case 'TLS-alert-received': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 14, true);
          var {alertId: v11_0, alertMessage: v11_1 } = e;
          var variant12 = v11_0;
          if (variant12 === null || variant12=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant12;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt8(arg3 + 17, toUint8(e), true);
          }
          var variant14 = v11_1;
          if (variant14 === null || variant14=== undefined) {
            dataView(memory0).setInt8(arg3 + 20, 0, true);
          } else {
            const e = variant14;
            dataView(memory0).setInt8(arg3 + 20, 1, true);
            var ptr13 = utf8Encode(e, realloc0, memory0);
            var len13 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 28, len13, true);
            dataView(memory0).setUint32(arg3 + 24, ptr13, true);
          }
          break;
        }
        case 'HTTP-request-denied': {
          dataView(memory0).setInt8(arg3 + 8, 15, true);
          break;
        }
        case 'HTTP-request-length-required': {
          dataView(memory0).setInt8(arg3 + 8, 16, true);
          break;
        }
        case 'HTTP-request-body-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 17, true);
          var variant15 = e;
          if (variant15 === null || variant15=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant15;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setBigInt64(arg3 + 24, toUint64(e), true);
          }
          break;
        }
        case 'HTTP-request-method-invalid': {
          dataView(memory0).setInt8(arg3 + 8, 18, true);
          break;
        }
        case 'HTTP-request-URI-invalid': {
          dataView(memory0).setInt8(arg3 + 8, 19, true);
          break;
        }
        case 'HTTP-request-URI-too-long': {
          dataView(memory0).setInt8(arg3 + 8, 20, true);
          break;
        }
        case 'HTTP-request-header-section-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 21, true);
          var variant16 = e;
          if (variant16 === null || variant16=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant16;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt32(arg3 + 20, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-request-header-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 22, true);
          var variant21 = e;
          if (variant21 === null || variant21=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant21;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var {fieldName: v17_0, fieldSize: v17_1 } = e;
            var variant19 = v17_0;
            if (variant19 === null || variant19=== undefined) {
              dataView(memory0).setInt8(arg3 + 20, 0, true);
            } else {
              const e = variant19;
              dataView(memory0).setInt8(arg3 + 20, 1, true);
              var ptr18 = utf8Encode(e, realloc0, memory0);
              var len18 = utf8EncodedLen;
              dataView(memory0).setUint32(arg3 + 28, len18, true);
              dataView(memory0).setUint32(arg3 + 24, ptr18, true);
            }
            var variant20 = v17_1;
            if (variant20 === null || variant20=== undefined) {
              dataView(memory0).setInt8(arg3 + 32, 0, true);
            } else {
              const e = variant20;
              dataView(memory0).setInt8(arg3 + 32, 1, true);
              dataView(memory0).setInt32(arg3 + 36, toUint32(e), true);
            }
          }
          break;
        }
        case 'HTTP-request-trailer-section-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 23, true);
          var variant22 = e;
          if (variant22 === null || variant22=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant22;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt32(arg3 + 20, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-request-trailer-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 24, true);
          var {fieldName: v23_0, fieldSize: v23_1 } = e;
          var variant25 = v23_0;
          if (variant25 === null || variant25=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant25;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr24 = utf8Encode(e, realloc0, memory0);
            var len24 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len24, true);
            dataView(memory0).setUint32(arg3 + 20, ptr24, true);
          }
          var variant26 = v23_1;
          if (variant26 === null || variant26=== undefined) {
            dataView(memory0).setInt8(arg3 + 28, 0, true);
          } else {
            const e = variant26;
            dataView(memory0).setInt8(arg3 + 28, 1, true);
            dataView(memory0).setInt32(arg3 + 32, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-incomplete': {
          dataView(memory0).setInt8(arg3 + 8, 25, true);
          break;
        }
        case 'HTTP-response-header-section-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 26, true);
          var variant27 = e;
          if (variant27 === null || variant27=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant27;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt32(arg3 + 20, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-header-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 27, true);
          var {fieldName: v28_0, fieldSize: v28_1 } = e;
          var variant30 = v28_0;
          if (variant30 === null || variant30=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant30;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr29 = utf8Encode(e, realloc0, memory0);
            var len29 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len29, true);
            dataView(memory0).setUint32(arg3 + 20, ptr29, true);
          }
          var variant31 = v28_1;
          if (variant31 === null || variant31=== undefined) {
            dataView(memory0).setInt8(arg3 + 28, 0, true);
          } else {
            const e = variant31;
            dataView(memory0).setInt8(arg3 + 28, 1, true);
            dataView(memory0).setInt32(arg3 + 32, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-body-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 28, true);
          var variant32 = e;
          if (variant32 === null || variant32=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant32;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setBigInt64(arg3 + 24, toUint64(e), true);
          }
          break;
        }
        case 'HTTP-response-trailer-section-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 29, true);
          var variant33 = e;
          if (variant33 === null || variant33=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant33;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt32(arg3 + 20, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-trailer-size': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 30, true);
          var {fieldName: v34_0, fieldSize: v34_1 } = e;
          var variant36 = v34_0;
          if (variant36 === null || variant36=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant36;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr35 = utf8Encode(e, realloc0, memory0);
            var len35 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len35, true);
            dataView(memory0).setUint32(arg3 + 20, ptr35, true);
          }
          var variant37 = v34_1;
          if (variant37 === null || variant37=== undefined) {
            dataView(memory0).setInt8(arg3 + 28, 0, true);
          } else {
            const e = variant37;
            dataView(memory0).setInt8(arg3 + 28, 1, true);
            dataView(memory0).setInt32(arg3 + 32, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-transfer-coding': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 31, true);
          var variant39 = e;
          if (variant39 === null || variant39=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant39;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr38 = utf8Encode(e, realloc0, memory0);
            var len38 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len38, true);
            dataView(memory0).setUint32(arg3 + 20, ptr38, true);
          }
          break;
        }
        case 'HTTP-response-content-coding': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 32, true);
          var variant41 = e;
          if (variant41 === null || variant41=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant41;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr40 = utf8Encode(e, realloc0, memory0);
            var len40 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len40, true);
            dataView(memory0).setUint32(arg3 + 20, ptr40, true);
          }
          break;
        }
        case 'HTTP-response-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 33, true);
          break;
        }
        case 'HTTP-upgrade-failed': {
          dataView(memory0).setInt8(arg3 + 8, 34, true);
          break;
        }
        case 'HTTP-protocol-error': {
          dataView(memory0).setInt8(arg3 + 8, 35, true);
          break;
        }
        case 'loop-detected': {
          dataView(memory0).setInt8(arg3 + 8, 36, true);
          break;
        }
        case 'configuration-error': {
          dataView(memory0).setInt8(arg3 + 8, 37, true);
          break;
        }
        case 'internal-error': {
          const e = variant44.val;
          dataView(memory0).setInt8(arg3 + 8, 38, true);
          var variant43 = e;
          if (variant43 === null || variant43=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant43;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr42 = utf8Encode(e, realloc0, memory0);
            var len42 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len42, true);
            dataView(memory0).setUint32(arg3 + 20, ptr42, true);
          }
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant44.tag)}\` (received \`${variant44}\`) specified for \`ErrorCode\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[static]outgoing-body.finish"][Instruction::Return]', {
    funcName: '[static]outgoing-body.finish',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline61(arg0, arg1, arg2, arg3, arg4, arg5) {
  var handle1 = arg0;
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Fields.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
  var len5 = arg4;
  var base5 = arg3;
  var result5 = [];
  for (let i = 0; i < len5; i++) {
    const base = base5 + i * 8;
    var ptr4 = dataView(memory0).getUint32(base + 0, true);
    var len4 = dataView(memory0).getUint32(base + 4, true);
    var result4 = new Uint8Array(memory0.buffer.slice(ptr4, ptr4 + len4 * 1));
    result5.push(result4);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]fields.set"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]fields.set');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.set(result3, result5)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]fields.set"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant7 = ret;
  switch (variant7.tag) {
    case 'ok': {
      const e = variant7.val;
      dataView(memory0).setInt8(arg5 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant7.val;
      dataView(memory0).setInt8(arg5 + 0, 1, true);
      var variant6 = e;
      switch (variant6.tag) {
        case 'invalid-syntax': {
          dataView(memory0).setInt8(arg5 + 1, 0, true);
          break;
        }
        case 'forbidden': {
          dataView(memory0).setInt8(arg5 + 1, 1, true);
          break;
        }
        case 'immutable': {
          dataView(memory0).setInt8(arg5 + 1, 2, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant6.tag)}\` (received \`${variant6}\`) specified for \`HeaderError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]fields.set"][Instruction::Return]', {
    funcName: '[method]fields.set',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline62(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable10[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable10.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(IncomingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-request.path-with-query"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]incoming-request.path-with-query');
  const ret = rsc0.pathWithQuery();
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-request.path-with-query"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant4 = ret;
  if (variant4 === null || variant4=== undefined) {
    dataView(memory0).setInt8(arg1 + 0, 0, true);
  } else {
    const e = variant4;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var ptr3 = utf8Encode(e, realloc0, memory0);
    var len3 = utf8EncodedLen;
    dataView(memory0).setUint32(arg1 + 8, len3, true);
    dataView(memory0).setUint32(arg1 + 4, ptr3, true);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-request.path-with-query"][Instruction::Return]', {
    funcName: '[method]incoming-request.path-with-query',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline63(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable10[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable10.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(IncomingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-request.consume"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]incoming-request.consume');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.consume()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-request.consume"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant4 = ret;
  switch (variant4.tag) {
    case 'ok': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      if (!(e instanceof IncomingBody)) {
        throw new TypeError('Resource error: Not a valid "IncomingBody" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt9;
        captureTable9.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable9, rep);
      }
      dataView(memory0).setInt32(arg1 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-request.consume"][Instruction::Return]', {
    funcName: '[method]incoming-request.consume',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline64(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Fields.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]fields.entries"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]fields.entries');
  const ret = rsc0.entries();
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]fields.entries"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var vec6 = ret;
  var len6 = vec6.length;
  var result6 = realloc0(0, 0, 4, len6 * 16);
  for (let i = 0; i < vec6.length; i++) {
    const e = vec6[i];
    const base = result6 + i * 16;var [tuple3_0, tuple3_1] = e;
    var ptr4 = utf8Encode(tuple3_0, realloc0, memory0);
    var len4 = utf8EncodedLen;
    dataView(memory0).setUint32(base + 4, len4, true);
    dataView(memory0).setUint32(base + 0, ptr4, true);
    var val5 = tuple3_1;
    var len5 = val5.byteLength;
    var ptr5 = realloc0(0, 0, 1, len5 * 1);
    var src5 = new Uint8Array(val5.buffer || val5, val5.byteOffset, len5 * 1);
    (new Uint8Array(memory0.buffer, ptr5, len5 * 1)).set(src5);
    dataView(memory0).setUint32(base + 12, len5, true);
    dataView(memory0).setUint32(base + 8, ptr5, true);
  }
  dataView(memory0).setUint32(arg1 + 4, len6, true);
  dataView(memory0).setUint32(arg1 + 0, result6, true);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]fields.entries"][Instruction::Return]', {
    funcName: '[method]fields.entries',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline65(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable12[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable12.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingResponse.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-response.body"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]outgoing-response.body');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.body()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-response.body"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant4 = ret;
  switch (variant4.tag) {
    case 'ok': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      if (!(e instanceof OutgoingBody)) {
        throw new TypeError('Resource error: Not a valid "OutgoingBody" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt6;
        captureTable6.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable6, rep);
      }
      dataView(memory0).setInt32(arg1 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-response.body"][Instruction::Return]', {
    funcName: '[method]outgoing-response.body',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

const handleTable13 = [T_FLAG, 0];
const captureTable13= new Map();
let captureCnt13 = 0;
handleTables[13] = handleTable13;

function trampoline66(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
  var handle1 = arg0;
  var rep2 = handleTable13[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable13.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(ResponseOutparam.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  else {
    captureTable13.delete(rep2);
  }
  rscTableRemove(handleTable13, handle1);
  let variant38;
  if (arg1) {
    let variant37;
    switch (arg2) {
      case 0: {
        variant37= {
          tag: 'DNS-timeout',
        };
        break;
      }
      case 1: {
        let variant7;
        if (arg3) {
          var ptr6 = Number(arg4);
          var len6 = arg5;
          var result6 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr6, len6));
          variant7 = result6;
        } else {
          variant7 = undefined;
        }
        let variant8;
        if (arg6) {
          variant8 = clampGuest(arg7, 0, 65535);
        } else {
          variant8 = undefined;
        }
        variant37= {
          tag: 'DNS-error',
          val: {
            rcode: variant7,
            infoCode: variant8,
          }
        };
        break;
      }
      case 2: {
        variant37= {
          tag: 'destination-not-found',
        };
        break;
      }
      case 3: {
        variant37= {
          tag: 'destination-unavailable',
        };
        break;
      }
      case 4: {
        variant37= {
          tag: 'destination-IP-prohibited',
        };
        break;
      }
      case 5: {
        variant37= {
          tag: 'destination-IP-unroutable',
        };
        break;
      }
      case 6: {
        variant37= {
          tag: 'connection-refused',
        };
        break;
      }
      case 7: {
        variant37= {
          tag: 'connection-terminated',
        };
        break;
      }
      case 8: {
        variant37= {
          tag: 'connection-timeout',
        };
        break;
      }
      case 9: {
        variant37= {
          tag: 'connection-read-timeout',
        };
        break;
      }
      case 10: {
        variant37= {
          tag: 'connection-write-timeout',
        };
        break;
      }
      case 11: {
        variant37= {
          tag: 'connection-limit-reached',
        };
        break;
      }
      case 12: {
        variant37= {
          tag: 'TLS-protocol-error',
        };
        break;
      }
      case 13: {
        variant37= {
          tag: 'TLS-certificate-error',
        };
        break;
      }
      case 14: {
        let variant9;
        if (arg3) {
          variant9 = clampGuest(Number(arg4), 0, 255);
        } else {
          variant9 = undefined;
        }
        let variant11;
        if (arg5) {
          var ptr10 = arg6;
          var len10 = arg7;
          var result10 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr10, len10));
          variant11 = result10;
        } else {
          variant11 = undefined;
        }
        variant37= {
          tag: 'TLS-alert-received',
          val: {
            alertId: variant9,
            alertMessage: variant11,
          }
        };
        break;
      }
      case 15: {
        variant37= {
          tag: 'HTTP-request-denied',
        };
        break;
      }
      case 16: {
        variant37= {
          tag: 'HTTP-request-length-required',
        };
        break;
      }
      case 17: {
        let variant12;
        if (arg3) {
          variant12 = BigInt.asUintN(64, arg4);
        } else {
          variant12 = undefined;
        }
        variant37= {
          tag: 'HTTP-request-body-size',
          val: variant12
        };
        break;
      }
      case 18: {
        variant37= {
          tag: 'HTTP-request-method-invalid',
        };
        break;
      }
      case 19: {
        variant37= {
          tag: 'HTTP-request-URI-invalid',
        };
        break;
      }
      case 20: {
        variant37= {
          tag: 'HTTP-request-URI-too-long',
        };
        break;
      }
      case 21: {
        let variant13;
        if (arg3) {
          variant13 = Number(arg4) >>> 0;
        } else {
          variant13 = undefined;
        }
        variant37= {
          tag: 'HTTP-request-header-section-size',
          val: variant13
        };
        break;
      }
      case 22: {
        let variant17;
        if (arg3) {
          let variant15;
          if (Number(arg4)) {
            var ptr14 = arg5;
            var len14 = arg6;
            var result14 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr14, len14));
            variant15 = result14;
          } else {
            variant15 = undefined;
          }
          let variant16;
          if (arg7) {
            variant16 = arg8 >>> 0;
          } else {
            variant16 = undefined;
          }
          variant17 = {
            fieldName: variant15,
            fieldSize: variant16,
          };
        } else {
          variant17 = undefined;
        }
        variant37= {
          tag: 'HTTP-request-header-size',
          val: variant17
        };
        break;
      }
      case 23: {
        let variant18;
        if (arg3) {
          variant18 = Number(arg4) >>> 0;
        } else {
          variant18 = undefined;
        }
        variant37= {
          tag: 'HTTP-request-trailer-section-size',
          val: variant18
        };
        break;
      }
      case 24: {
        let variant20;
        if (arg3) {
          var ptr19 = Number(arg4);
          var len19 = arg5;
          var result19 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr19, len19));
          variant20 = result19;
        } else {
          variant20 = undefined;
        }
        let variant21;
        if (arg6) {
          variant21 = arg7 >>> 0;
        } else {
          variant21 = undefined;
        }
        variant37= {
          tag: 'HTTP-request-trailer-size',
          val: {
            fieldName: variant20,
            fieldSize: variant21,
          }
        };
        break;
      }
      case 25: {
        variant37= {
          tag: 'HTTP-response-incomplete',
        };
        break;
      }
      case 26: {
        let variant22;
        if (arg3) {
          variant22 = Number(arg4) >>> 0;
        } else {
          variant22 = undefined;
        }
        variant37= {
          tag: 'HTTP-response-header-section-size',
          val: variant22
        };
        break;
      }
      case 27: {
        let variant24;
        if (arg3) {
          var ptr23 = Number(arg4);
          var len23 = arg5;
          var result23 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr23, len23));
          variant24 = result23;
        } else {
          variant24 = undefined;
        }
        let variant25;
        if (arg6) {
          variant25 = arg7 >>> 0;
        } else {
          variant25 = undefined;
        }
        variant37= {
          tag: 'HTTP-response-header-size',
          val: {
            fieldName: variant24,
            fieldSize: variant25,
          }
        };
        break;
      }
      case 28: {
        let variant26;
        if (arg3) {
          variant26 = BigInt.asUintN(64, arg4);
        } else {
          variant26 = undefined;
        }
        variant37= {
          tag: 'HTTP-response-body-size',
          val: variant26
        };
        break;
      }
      case 29: {
        let variant27;
        if (arg3) {
          variant27 = Number(arg4) >>> 0;
        } else {
          variant27 = undefined;
        }
        variant37= {
          tag: 'HTTP-response-trailer-section-size',
          val: variant27
        };
        break;
      }
      case 30: {
        let variant29;
        if (arg3) {
          var ptr28 = Number(arg4);
          var len28 = arg5;
          var result28 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr28, len28));
          variant29 = result28;
        } else {
          variant29 = undefined;
        }
        let variant30;
        if (arg6) {
          variant30 = arg7 >>> 0;
        } else {
          variant30 = undefined;
        }
        variant37= {
          tag: 'HTTP-response-trailer-size',
          val: {
            fieldName: variant29,
            fieldSize: variant30,
          }
        };
        break;
      }
      case 31: {
        let variant32;
        if (arg3) {
          var ptr31 = Number(arg4);
          var len31 = arg5;
          var result31 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr31, len31));
          variant32 = result31;
        } else {
          variant32 = undefined;
        }
        variant37= {
          tag: 'HTTP-response-transfer-coding',
          val: variant32
        };
        break;
      }
      case 32: {
        let variant34;
        if (arg3) {
          var ptr33 = Number(arg4);
          var len33 = arg5;
          var result33 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr33, len33));
          variant34 = result33;
        } else {
          variant34 = undefined;
        }
        variant37= {
          tag: 'HTTP-response-content-coding',
          val: variant34
        };
        break;
      }
      case 33: {
        variant37= {
          tag: 'HTTP-response-timeout',
        };
        break;
      }
      case 34: {
        variant37= {
          tag: 'HTTP-upgrade-failed',
        };
        break;
      }
      case 35: {
        variant37= {
          tag: 'HTTP-protocol-error',
        };
        break;
      }
      case 36: {
        variant37= {
          tag: 'loop-detected',
        };
        break;
      }
      case 37: {
        variant37= {
          tag: 'configuration-error',
        };
        break;
      }
      case 38: {
        let variant36;
        if (arg3) {
          var ptr35 = Number(arg4);
          var len35 = arg5;
          var result35 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr35, len35));
          variant36 = result35;
        } else {
          variant36 = undefined;
        }
        variant37= {
          tag: 'internal-error',
          val: variant36
        };
        break;
      }
    }
    variant38= {
      tag: 'err',
      val: variant37
    };
  } else {
    var handle4 = arg2;
    var rep5 = handleTable12[(handle4 << 1) + 1] & ~T_FLAG;
    var rsc3 = captureTable12.get(rep5);
    if (!rsc3) {
      rsc3 = Object.create(OutgoingResponse.prototype);
      Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
      Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
    }
    else {
      captureTable12.delete(rep5);
    }
    rscTableRemove(handleTable12, handle4);
    variant38= {
      tag: 'ok',
      val: rsc3
    };
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[static]response-outparam.set"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[static]response-outparam.set');
  ResponseOutparam.set(rsc0, variant38);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[static]response-outparam.set"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[static]response-outparam.set"][Instruction::Return]', {
    funcName: '[static]response-outparam.set',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

const handleTable1 = [T_FLAG, 0];
const captureTable1= new Map();
let captureCnt1 = 0;
handleTables[1] = handleTable1;

function trampoline67(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.write"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]output-stream.write');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.write(result3)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.write"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg3 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg3 + 0, 1, true);
      var variant5 = e;
      switch (variant5.tag) {
        case 'last-operation-failed': {
          const e = variant5.val;
          dataView(memory0).setInt8(arg3 + 4, 0, true);
          if (!(e instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid "Error" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep = e[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, e);
            handle4 = rscTableCreateOwn(handleTable1, rep);
          }
          dataView(memory0).setInt32(arg3 + 8, handle4, true);
          break;
        }
        case 'closed': {
          dataView(memory0).setInt8(arg3 + 4, 1, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.write"][Instruction::Return]', {
    funcName: '[method]output-stream.write',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline68(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable2.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(InputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.read"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]input-stream.read');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.read(BigInt.asUintN(64, arg1))};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.read"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg2 + 0, 0, true);
      var val3 = e;
      var len3 = val3.byteLength;
      var ptr3 = realloc0(0, 0, 1, len3 * 1);
      var src3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, len3 * 1);
      (new Uint8Array(memory0.buffer, ptr3, len3 * 1)).set(src3);
      dataView(memory0).setUint32(arg2 + 8, len3, true);
      dataView(memory0).setUint32(arg2 + 4, ptr3, true);
      break;
    }
    case 'err': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg2 + 0, 1, true);
      var variant5 = e;
      switch (variant5.tag) {
        case 'last-operation-failed': {
          const e = variant5.val;
          dataView(memory0).setInt8(arg2 + 4, 0, true);
          if (!(e instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid "Error" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep = e[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, e);
            handle4 = rscTableCreateOwn(handleTable1, rep);
          }
          dataView(memory0).setInt32(arg2 + 8, handle4, true);
          break;
        }
        case 'closed': {
          dataView(memory0).setInt8(arg2 + 4, 1, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.read"][Instruction::Return]', {
    funcName: '[method]input-stream.read',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline69(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable2.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(InputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.blocking-read"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]input-stream.blocking-read');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.blockingRead(BigInt.asUintN(64, arg1))};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.blocking-read"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg2 + 0, 0, true);
      var val3 = e;
      var len3 = val3.byteLength;
      var ptr3 = realloc0(0, 0, 1, len3 * 1);
      var src3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, len3 * 1);
      (new Uint8Array(memory0.buffer, ptr3, len3 * 1)).set(src3);
      dataView(memory0).setUint32(arg2 + 8, len3, true);
      dataView(memory0).setUint32(arg2 + 4, ptr3, true);
      break;
    }
    case 'err': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg2 + 0, 1, true);
      var variant5 = e;
      switch (variant5.tag) {
        case 'last-operation-failed': {
          const e = variant5.val;
          dataView(memory0).setInt8(arg2 + 4, 0, true);
          if (!(e instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid "Error" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep = e[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, e);
            handle4 = rscTableCreateOwn(handleTable1, rep);
          }
          dataView(memory0).setInt32(arg2 + 8, handle4, true);
          break;
        }
        case 'closed': {
          dataView(memory0).setInt8(arg2 + 4, 1, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.blocking-read"][Instruction::Return]', {
    funcName: '[method]input-stream.blocking-read',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline70(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-write-and-flush"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]output-stream.blocking-write-and-flush');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.blockingWriteAndFlush(result3)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-write-and-flush"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg3 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg3 + 0, 1, true);
      var variant5 = e;
      switch (variant5.tag) {
        case 'last-operation-failed': {
          const e = variant5.val;
          dataView(memory0).setInt8(arg3 + 4, 0, true);
          if (!(e instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid "Error" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep = e[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, e);
            handle4 = rscTableCreateOwn(handleTable1, rep);
          }
          dataView(memory0).setInt32(arg3 + 8, handle4, true);
          break;
        }
        case 'closed': {
          dataView(memory0).setInt8(arg3 + 4, 1, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-write-and-flush"][Instruction::Return]', {
    funcName: '[method]output-stream.blocking-write-and-flush',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

const handleTable14 = [T_FLAG, 0];
const captureTable14= new Map();
let captureCnt14 = 0;
handleTables[14] = handleTable14;

function trampoline71(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable5[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable5.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  else {
    captureTable5.delete(rep2);
  }
  rscTableRemove(handleTable5, handle1);
  let variant6;
  if (arg1) {
    var handle4 = arg2;
    var rep5 = handleTable14[(handle4 << 1) + 1] & ~T_FLAG;
    var rsc3 = captureTable14.get(rep5);
    if (!rsc3) {
      rsc3 = Object.create(RequestOptions.prototype);
      Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
      Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
    }
    else {
      captureTable14.delete(rep5);
    }
    rscTableRemove(handleTable14, handle4);
    variant6 = rsc3;
  } else {
    variant6 = undefined;
  }
  _debugLog('[iface="wasi:http/outgoing-handler@0.2.4", function="handle"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'handle');
  let ret;
  try {
    ret = { tag: 'ok', val: handle(rsc0, variant6)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:http/outgoing-handler@0.2.4", function="handle"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var variant46 = ret;
  switch (variant46.tag) {
    case 'ok': {
      const e = variant46.val;
      dataView(memory0).setInt8(arg3 + 0, 0, true);
      if (!(e instanceof FutureIncomingResponse)) {
        throw new TypeError('Resource error: Not a valid "FutureIncomingResponse" resource.');
      }
      var handle7 = e[symbolRscHandle];
      if (!handle7) {
        const rep = e[symbolRscRep] || ++captureCnt7;
        captureTable7.set(rep, e);
        handle7 = rscTableCreateOwn(handleTable7, rep);
      }
      dataView(memory0).setInt32(arg3 + 8, handle7, true);
      break;
    }
    case 'err': {
      const e = variant46.val;
      dataView(memory0).setInt8(arg3 + 0, 1, true);
      var variant45 = e;
      switch (variant45.tag) {
        case 'DNS-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 0, true);
          break;
        }
        case 'DNS-error': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 1, true);
          var {rcode: v8_0, infoCode: v8_1 } = e;
          var variant10 = v8_0;
          if (variant10 === null || variant10=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant10;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr9 = utf8Encode(e, realloc0, memory0);
            var len9 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len9, true);
            dataView(memory0).setUint32(arg3 + 20, ptr9, true);
          }
          var variant11 = v8_1;
          if (variant11 === null || variant11=== undefined) {
            dataView(memory0).setInt8(arg3 + 28, 0, true);
          } else {
            const e = variant11;
            dataView(memory0).setInt8(arg3 + 28, 1, true);
            dataView(memory0).setInt16(arg3 + 30, toUint16(e), true);
          }
          break;
        }
        case 'destination-not-found': {
          dataView(memory0).setInt8(arg3 + 8, 2, true);
          break;
        }
        case 'destination-unavailable': {
          dataView(memory0).setInt8(arg3 + 8, 3, true);
          break;
        }
        case 'destination-IP-prohibited': {
          dataView(memory0).setInt8(arg3 + 8, 4, true);
          break;
        }
        case 'destination-IP-unroutable': {
          dataView(memory0).setInt8(arg3 + 8, 5, true);
          break;
        }
        case 'connection-refused': {
          dataView(memory0).setInt8(arg3 + 8, 6, true);
          break;
        }
        case 'connection-terminated': {
          dataView(memory0).setInt8(arg3 + 8, 7, true);
          break;
        }
        case 'connection-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 8, true);
          break;
        }
        case 'connection-read-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 9, true);
          break;
        }
        case 'connection-write-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 10, true);
          break;
        }
        case 'connection-limit-reached': {
          dataView(memory0).setInt8(arg3 + 8, 11, true);
          break;
        }
        case 'TLS-protocol-error': {
          dataView(memory0).setInt8(arg3 + 8, 12, true);
          break;
        }
        case 'TLS-certificate-error': {
          dataView(memory0).setInt8(arg3 + 8, 13, true);
          break;
        }
        case 'TLS-alert-received': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 14, true);
          var {alertId: v12_0, alertMessage: v12_1 } = e;
          var variant13 = v12_0;
          if (variant13 === null || variant13=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant13;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt8(arg3 + 17, toUint8(e), true);
          }
          var variant15 = v12_1;
          if (variant15 === null || variant15=== undefined) {
            dataView(memory0).setInt8(arg3 + 20, 0, true);
          } else {
            const e = variant15;
            dataView(memory0).setInt8(arg3 + 20, 1, true);
            var ptr14 = utf8Encode(e, realloc0, memory0);
            var len14 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 28, len14, true);
            dataView(memory0).setUint32(arg3 + 24, ptr14, true);
          }
          break;
        }
        case 'HTTP-request-denied': {
          dataView(memory0).setInt8(arg3 + 8, 15, true);
          break;
        }
        case 'HTTP-request-length-required': {
          dataView(memory0).setInt8(arg3 + 8, 16, true);
          break;
        }
        case 'HTTP-request-body-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 17, true);
          var variant16 = e;
          if (variant16 === null || variant16=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant16;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setBigInt64(arg3 + 24, toUint64(e), true);
          }
          break;
        }
        case 'HTTP-request-method-invalid': {
          dataView(memory0).setInt8(arg3 + 8, 18, true);
          break;
        }
        case 'HTTP-request-URI-invalid': {
          dataView(memory0).setInt8(arg3 + 8, 19, true);
          break;
        }
        case 'HTTP-request-URI-too-long': {
          dataView(memory0).setInt8(arg3 + 8, 20, true);
          break;
        }
        case 'HTTP-request-header-section-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 21, true);
          var variant17 = e;
          if (variant17 === null || variant17=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant17;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt32(arg3 + 20, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-request-header-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 22, true);
          var variant22 = e;
          if (variant22 === null || variant22=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant22;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var {fieldName: v18_0, fieldSize: v18_1 } = e;
            var variant20 = v18_0;
            if (variant20 === null || variant20=== undefined) {
              dataView(memory0).setInt8(arg3 + 20, 0, true);
            } else {
              const e = variant20;
              dataView(memory0).setInt8(arg3 + 20, 1, true);
              var ptr19 = utf8Encode(e, realloc0, memory0);
              var len19 = utf8EncodedLen;
              dataView(memory0).setUint32(arg3 + 28, len19, true);
              dataView(memory0).setUint32(arg3 + 24, ptr19, true);
            }
            var variant21 = v18_1;
            if (variant21 === null || variant21=== undefined) {
              dataView(memory0).setInt8(arg3 + 32, 0, true);
            } else {
              const e = variant21;
              dataView(memory0).setInt8(arg3 + 32, 1, true);
              dataView(memory0).setInt32(arg3 + 36, toUint32(e), true);
            }
          }
          break;
        }
        case 'HTTP-request-trailer-section-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 23, true);
          var variant23 = e;
          if (variant23 === null || variant23=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant23;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt32(arg3 + 20, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-request-trailer-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 24, true);
          var {fieldName: v24_0, fieldSize: v24_1 } = e;
          var variant26 = v24_0;
          if (variant26 === null || variant26=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant26;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr25 = utf8Encode(e, realloc0, memory0);
            var len25 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len25, true);
            dataView(memory0).setUint32(arg3 + 20, ptr25, true);
          }
          var variant27 = v24_1;
          if (variant27 === null || variant27=== undefined) {
            dataView(memory0).setInt8(arg3 + 28, 0, true);
          } else {
            const e = variant27;
            dataView(memory0).setInt8(arg3 + 28, 1, true);
            dataView(memory0).setInt32(arg3 + 32, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-incomplete': {
          dataView(memory0).setInt8(arg3 + 8, 25, true);
          break;
        }
        case 'HTTP-response-header-section-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 26, true);
          var variant28 = e;
          if (variant28 === null || variant28=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant28;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt32(arg3 + 20, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-header-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 27, true);
          var {fieldName: v29_0, fieldSize: v29_1 } = e;
          var variant31 = v29_0;
          if (variant31 === null || variant31=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant31;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr30 = utf8Encode(e, realloc0, memory0);
            var len30 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len30, true);
            dataView(memory0).setUint32(arg3 + 20, ptr30, true);
          }
          var variant32 = v29_1;
          if (variant32 === null || variant32=== undefined) {
            dataView(memory0).setInt8(arg3 + 28, 0, true);
          } else {
            const e = variant32;
            dataView(memory0).setInt8(arg3 + 28, 1, true);
            dataView(memory0).setInt32(arg3 + 32, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-body-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 28, true);
          var variant33 = e;
          if (variant33 === null || variant33=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant33;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setBigInt64(arg3 + 24, toUint64(e), true);
          }
          break;
        }
        case 'HTTP-response-trailer-section-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 29, true);
          var variant34 = e;
          if (variant34 === null || variant34=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant34;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            dataView(memory0).setInt32(arg3 + 20, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-trailer-size': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 30, true);
          var {fieldName: v35_0, fieldSize: v35_1 } = e;
          var variant37 = v35_0;
          if (variant37 === null || variant37=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant37;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr36 = utf8Encode(e, realloc0, memory0);
            var len36 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len36, true);
            dataView(memory0).setUint32(arg3 + 20, ptr36, true);
          }
          var variant38 = v35_1;
          if (variant38 === null || variant38=== undefined) {
            dataView(memory0).setInt8(arg3 + 28, 0, true);
          } else {
            const e = variant38;
            dataView(memory0).setInt8(arg3 + 28, 1, true);
            dataView(memory0).setInt32(arg3 + 32, toUint32(e), true);
          }
          break;
        }
        case 'HTTP-response-transfer-coding': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 31, true);
          var variant40 = e;
          if (variant40 === null || variant40=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant40;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr39 = utf8Encode(e, realloc0, memory0);
            var len39 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len39, true);
            dataView(memory0).setUint32(arg3 + 20, ptr39, true);
          }
          break;
        }
        case 'HTTP-response-content-coding': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 32, true);
          var variant42 = e;
          if (variant42 === null || variant42=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant42;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr41 = utf8Encode(e, realloc0, memory0);
            var len41 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len41, true);
            dataView(memory0).setUint32(arg3 + 20, ptr41, true);
          }
          break;
        }
        case 'HTTP-response-timeout': {
          dataView(memory0).setInt8(arg3 + 8, 33, true);
          break;
        }
        case 'HTTP-upgrade-failed': {
          dataView(memory0).setInt8(arg3 + 8, 34, true);
          break;
        }
        case 'HTTP-protocol-error': {
          dataView(memory0).setInt8(arg3 + 8, 35, true);
          break;
        }
        case 'loop-detected': {
          dataView(memory0).setInt8(arg3 + 8, 36, true);
          break;
        }
        case 'configuration-error': {
          dataView(memory0).setInt8(arg3 + 8, 37, true);
          break;
        }
        case 'internal-error': {
          const e = variant45.val;
          dataView(memory0).setInt8(arg3 + 8, 38, true);
          var variant44 = e;
          if (variant44 === null || variant44=== undefined) {
            dataView(memory0).setInt8(arg3 + 16, 0, true);
          } else {
            const e = variant44;
            dataView(memory0).setInt8(arg3 + 16, 1, true);
            var ptr43 = utf8Encode(e, realloc0, memory0);
            var len43 = utf8EncodedLen;
            dataView(memory0).setUint32(arg3 + 24, len43, true);
            dataView(memory0).setUint32(arg3 + 20, ptr43, true);
          }
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant45.tag)}\` (received \`${variant45}\`) specified for \`ErrorCode\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:http/outgoing-handler@0.2.4", function="handle"][Instruction::Return]', {
    funcName: 'handle',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline72(arg0) {
  _debugLog('[iface="wasi:clocks/wall-clock@0.2.6", function="now"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'now');
  const ret = now$1();
  _debugLog('[iface="wasi:clocks/wall-clock@0.2.6", function="now"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var {seconds: v0_0, nanoseconds: v0_1 } = ret;
  dataView(memory0).setBigInt64(arg0 + 0, toUint64(v0_0), true);
  dataView(memory0).setInt32(arg0 + 8, toUint32(v0_1), true);
  _debugLog('[iface="wasi:clocks/wall-clock@0.2.6", function="now"][Instruction::Return]', {
    funcName: 'now',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline73(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable1[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable1.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Error$1.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/error@0.2.6", function="[method]error.to-debug-string"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]error.to-debug-string');
  const ret = rsc0.toDebugString();
  _debugLog('[iface="wasi:io/error@0.2.6", function="[method]error.to-debug-string"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var ptr3 = utf8Encode(ret, realloc0, memory0);
  var len3 = utf8EncodedLen;
  dataView(memory0).setUint32(arg1 + 4, len3, true);
  dataView(memory0).setUint32(arg1 + 0, ptr3, true);
  _debugLog('[iface="wasi:io/error@0.2.6", function="[method]error.to-debug-string"][Instruction::Return]', {
    funcName: '[method]error.to-debug-string',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline74(arg0) {
  _debugLog('[iface="wasi:random/insecure-seed@0.2.6", function="insecure-seed"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'insecure-seed');
  const ret = insecureSeed();
  _debugLog('[iface="wasi:random/insecure-seed@0.2.6", function="insecure-seed"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var [tuple0_0, tuple0_1] = ret;
  dataView(memory0).setBigInt64(arg0 + 0, toUint64(tuple0_0), true);
  dataView(memory0).setBigInt64(arg0 + 8, toUint64(tuple0_1), true);
  _debugLog('[iface="wasi:random/insecure-seed@0.2.6", function="insecure-seed"][Instruction::Return]', {
    funcName: 'insecure-seed',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline75(arg0) {
  _debugLog('[iface="wasi:cli/environment@0.2.6", function="get-environment"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-environment');
  const ret = getEnvironment();
  _debugLog('[iface="wasi:cli/environment@0.2.6", function="get-environment"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var vec3 = ret;
  var len3 = vec3.length;
  var result3 = realloc1(0, 0, 4, len3 * 16);
  for (let i = 0; i < vec3.length; i++) {
    const e = vec3[i];
    const base = result3 + i * 16;var [tuple0_0, tuple0_1] = e;
    var ptr1 = utf8Encode(tuple0_0, realloc1, memory0);
    var len1 = utf8EncodedLen;
    dataView(memory0).setUint32(base + 4, len1, true);
    dataView(memory0).setUint32(base + 0, ptr1, true);
    var ptr2 = utf8Encode(tuple0_1, realloc1, memory0);
    var len2 = utf8EncodedLen;
    dataView(memory0).setUint32(base + 12, len2, true);
    dataView(memory0).setUint32(base + 8, ptr2, true);
  }
  dataView(memory0).setUint32(arg0 + 4, len3, true);
  dataView(memory0).setUint32(arg0 + 0, result3, true);
  _debugLog('[iface="wasi:cli/environment@0.2.6", function="get-environment"][Instruction::Return]', {
    funcName: 'get-environment',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

const handleTable19 = [T_FLAG, 0];
const captureTable19= new Map();
let captureCnt19 = 0;
handleTables[19] = handleTable19;

function trampoline76(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.set-size"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.set-size');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.setSize(BigInt.asUintN(64, arg1))};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.set-size"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant4 = ret;
  switch (variant4.tag) {
    case 'ok': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg2 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant4.val;
      dataView(memory0).setInt8(arg2 + 0, 1, true);
      var val3 = e;
      let enum3;
      switch (val3) {
        case 'access': {
          enum3 = 0;
          break;
        }
        case 'would-block': {
          enum3 = 1;
          break;
        }
        case 'already': {
          enum3 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum3 = 3;
          break;
        }
        case 'busy': {
          enum3 = 4;
          break;
        }
        case 'deadlock': {
          enum3 = 5;
          break;
        }
        case 'quota': {
          enum3 = 6;
          break;
        }
        case 'exist': {
          enum3 = 7;
          break;
        }
        case 'file-too-large': {
          enum3 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum3 = 9;
          break;
        }
        case 'in-progress': {
          enum3 = 10;
          break;
        }
        case 'interrupted': {
          enum3 = 11;
          break;
        }
        case 'invalid': {
          enum3 = 12;
          break;
        }
        case 'io': {
          enum3 = 13;
          break;
        }
        case 'is-directory': {
          enum3 = 14;
          break;
        }
        case 'loop': {
          enum3 = 15;
          break;
        }
        case 'too-many-links': {
          enum3 = 16;
          break;
        }
        case 'message-size': {
          enum3 = 17;
          break;
        }
        case 'name-too-long': {
          enum3 = 18;
          break;
        }
        case 'no-device': {
          enum3 = 19;
          break;
        }
        case 'no-entry': {
          enum3 = 20;
          break;
        }
        case 'no-lock': {
          enum3 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum3 = 22;
          break;
        }
        case 'insufficient-space': {
          enum3 = 23;
          break;
        }
        case 'not-directory': {
          enum3 = 24;
          break;
        }
        case 'not-empty': {
          enum3 = 25;
          break;
        }
        case 'not-recoverable': {
          enum3 = 26;
          break;
        }
        case 'unsupported': {
          enum3 = 27;
          break;
        }
        case 'no-tty': {
          enum3 = 28;
          break;
        }
        case 'no-such-device': {
          enum3 = 29;
          break;
        }
        case 'overflow': {
          enum3 = 30;
          break;
        }
        case 'not-permitted': {
          enum3 = 31;
          break;
        }
        case 'pipe': {
          enum3 = 32;
          break;
        }
        case 'read-only': {
          enum3 = 33;
          break;
        }
        case 'invalid-seek': {
          enum3 = 34;
          break;
        }
        case 'text-file-busy': {
          enum3 = 35;
          break;
        }
        case 'cross-device': {
          enum3 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val3}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg2 + 1, enum3, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.set-size"][Instruction::Return]', {
    funcName: '[method]descriptor.set-size',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline77(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable1[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable1.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Error$1.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="filesystem-error-code"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'filesystem-error-code');
  const ret = filesystemErrorCode(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="filesystem-error-code"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant4 = ret;
  if (variant4 === null || variant4=== undefined) {
    dataView(memory0).setInt8(arg1 + 0, 0, true);
  } else {
    const e = variant4;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val3 = e;
    let enum3;
    switch (val3) {
      case 'access': {
        enum3 = 0;
        break;
      }
      case 'would-block': {
        enum3 = 1;
        break;
      }
      case 'already': {
        enum3 = 2;
        break;
      }
      case 'bad-descriptor': {
        enum3 = 3;
        break;
      }
      case 'busy': {
        enum3 = 4;
        break;
      }
      case 'deadlock': {
        enum3 = 5;
        break;
      }
      case 'quota': {
        enum3 = 6;
        break;
      }
      case 'exist': {
        enum3 = 7;
        break;
      }
      case 'file-too-large': {
        enum3 = 8;
        break;
      }
      case 'illegal-byte-sequence': {
        enum3 = 9;
        break;
      }
      case 'in-progress': {
        enum3 = 10;
        break;
      }
      case 'interrupted': {
        enum3 = 11;
        break;
      }
      case 'invalid': {
        enum3 = 12;
        break;
      }
      case 'io': {
        enum3 = 13;
        break;
      }
      case 'is-directory': {
        enum3 = 14;
        break;
      }
      case 'loop': {
        enum3 = 15;
        break;
      }
      case 'too-many-links': {
        enum3 = 16;
        break;
      }
      case 'message-size': {
        enum3 = 17;
        break;
      }
      case 'name-too-long': {
        enum3 = 18;
        break;
      }
      case 'no-device': {
        enum3 = 19;
        break;
      }
      case 'no-entry': {
        enum3 = 20;
        break;
      }
      case 'no-lock': {
        enum3 = 21;
        break;
      }
      case 'insufficient-memory': {
        enum3 = 22;
        break;
      }
      case 'insufficient-space': {
        enum3 = 23;
        break;
      }
      case 'not-directory': {
        enum3 = 24;
        break;
      }
      case 'not-empty': {
        enum3 = 25;
        break;
      }
      case 'not-recoverable': {
        enum3 = 26;
        break;
      }
      case 'unsupported': {
        enum3 = 27;
        break;
      }
      case 'no-tty': {
        enum3 = 28;
        break;
      }
      case 'no-such-device': {
        enum3 = 29;
        break;
      }
      case 'overflow': {
        enum3 = 30;
        break;
      }
      case 'not-permitted': {
        enum3 = 31;
        break;
      }
      case 'pipe': {
        enum3 = 32;
        break;
      }
      case 'read-only': {
        enum3 = 33;
        break;
      }
      case 'invalid-seek': {
        enum3 = 34;
        break;
      }
      case 'text-file-busy': {
        enum3 = 35;
        break;
      }
      case 'cross-device': {
        enum3 = 36;
        break;
      }
      default: {
        
        throw new TypeError(`"${val3}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 1, enum3, true);
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="filesystem-error-code"][Instruction::Return]', {
    funcName: 'filesystem-error-code',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

const handleTable18 = [T_FLAG, 0];
const captureTable18= new Map();
let captureCnt18 = 0;
handleTables[18] = handleTable18;

function trampoline78(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.read-directory"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.read-directory');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.readDirectory()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.read-directory"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      if (!(e instanceof DirectoryEntryStream)) {
        throw new TypeError('Resource error: Not a valid "DirectoryEntryStream" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt18;
        captureTable18.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable18, rep);
      }
      dataView(memory0).setInt32(arg1 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg1 + 4, enum4, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.read-directory"][Instruction::Return]', {
    funcName: '[method]descriptor.read-directory',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline79(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable18[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable18.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(DirectoryEntryStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]directory-entry-stream.read-directory-entry"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]directory-entry-stream.read-directory-entry');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.readDirectoryEntry()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]directory-entry-stream.read-directory-entry"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant8 = ret;
  switch (variant8.tag) {
    case 'ok': {
      const e = variant8.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      var variant6 = e;
      if (variant6 === null || variant6=== undefined) {
        dataView(memory0).setInt8(arg1 + 4, 0, true);
      } else {
        const e = variant6;
        dataView(memory0).setInt8(arg1 + 4, 1, true);
        var {type: v3_0, name: v3_1 } = e;
        var val4 = v3_0;
        let enum4;
        switch (val4) {
          case 'unknown': {
            enum4 = 0;
            break;
          }
          case 'block-device': {
            enum4 = 1;
            break;
          }
          case 'character-device': {
            enum4 = 2;
            break;
          }
          case 'directory': {
            enum4 = 3;
            break;
          }
          case 'fifo': {
            enum4 = 4;
            break;
          }
          case 'symbolic-link': {
            enum4 = 5;
            break;
          }
          case 'regular-file': {
            enum4 = 6;
            break;
          }
          case 'socket': {
            enum4 = 7;
            break;
          }
          default: {
            
            throw new TypeError(`"${val4}" is not one of the cases of descriptor-type`);
          }
        }
        dataView(memory0).setInt8(arg1 + 8, enum4, true);
        var ptr5 = utf8Encode(v3_1, realloc1, memory0);
        var len5 = utf8EncodedLen;
        dataView(memory0).setUint32(arg1 + 16, len5, true);
        dataView(memory0).setUint32(arg1 + 12, ptr5, true);
      }
      break;
    }
    case 'err': {
      const e = variant8.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      var val7 = e;
      let enum7;
      switch (val7) {
        case 'access': {
          enum7 = 0;
          break;
        }
        case 'would-block': {
          enum7 = 1;
          break;
        }
        case 'already': {
          enum7 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum7 = 3;
          break;
        }
        case 'busy': {
          enum7 = 4;
          break;
        }
        case 'deadlock': {
          enum7 = 5;
          break;
        }
        case 'quota': {
          enum7 = 6;
          break;
        }
        case 'exist': {
          enum7 = 7;
          break;
        }
        case 'file-too-large': {
          enum7 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum7 = 9;
          break;
        }
        case 'in-progress': {
          enum7 = 10;
          break;
        }
        case 'interrupted': {
          enum7 = 11;
          break;
        }
        case 'invalid': {
          enum7 = 12;
          break;
        }
        case 'io': {
          enum7 = 13;
          break;
        }
        case 'is-directory': {
          enum7 = 14;
          break;
        }
        case 'loop': {
          enum7 = 15;
          break;
        }
        case 'too-many-links': {
          enum7 = 16;
          break;
        }
        case 'message-size': {
          enum7 = 17;
          break;
        }
        case 'name-too-long': {
          enum7 = 18;
          break;
        }
        case 'no-device': {
          enum7 = 19;
          break;
        }
        case 'no-entry': {
          enum7 = 20;
          break;
        }
        case 'no-lock': {
          enum7 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum7 = 22;
          break;
        }
        case 'insufficient-space': {
          enum7 = 23;
          break;
        }
        case 'not-directory': {
          enum7 = 24;
          break;
        }
        case 'not-empty': {
          enum7 = 25;
          break;
        }
        case 'not-recoverable': {
          enum7 = 26;
          break;
        }
        case 'unsupported': {
          enum7 = 27;
          break;
        }
        case 'no-tty': {
          enum7 = 28;
          break;
        }
        case 'no-such-device': {
          enum7 = 29;
          break;
        }
        case 'overflow': {
          enum7 = 30;
          break;
        }
        case 'not-permitted': {
          enum7 = 31;
          break;
        }
        case 'pipe': {
          enum7 = 32;
          break;
        }
        case 'read-only': {
          enum7 = 33;
          break;
        }
        case 'invalid-seek': {
          enum7 = 34;
          break;
        }
        case 'text-file-busy': {
          enum7 = 35;
          break;
        }
        case 'cross-device': {
          enum7 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val7}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg1 + 4, enum7, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]directory-entry-stream.read-directory-entry"][Instruction::Return]', {
    funcName: '[method]directory-entry-stream.read-directory-entry',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline80(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.create-directory-at"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.create-directory-at');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.createDirectoryAt(result3)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.create-directory-at"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg3 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg3 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg3 + 1, enum4, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.create-directory-at"][Instruction::Return]', {
    funcName: '[method]descriptor.create-directory-at',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline81(arg0, arg1, arg2, arg3, arg4) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var flags3 = {
    symlinkFollow: Boolean(arg1 & 1),
  };
  var ptr4 = arg2;
  var len4 = arg3;
  var result4 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr4, len4));
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.stat-at"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.stat-at');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.statAt(flags3, result4)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.stat-at"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant14 = ret;
  switch (variant14.tag) {
    case 'ok': {
      const e = variant14.val;
      dataView(memory0).setInt8(arg4 + 0, 0, true);
      var {type: v5_0, linkCount: v5_1, size: v5_2, dataAccessTimestamp: v5_3, dataModificationTimestamp: v5_4, statusChangeTimestamp: v5_5 } = e;
      var val6 = v5_0;
      let enum6;
      switch (val6) {
        case 'unknown': {
          enum6 = 0;
          break;
        }
        case 'block-device': {
          enum6 = 1;
          break;
        }
        case 'character-device': {
          enum6 = 2;
          break;
        }
        case 'directory': {
          enum6 = 3;
          break;
        }
        case 'fifo': {
          enum6 = 4;
          break;
        }
        case 'symbolic-link': {
          enum6 = 5;
          break;
        }
        case 'regular-file': {
          enum6 = 6;
          break;
        }
        case 'socket': {
          enum6 = 7;
          break;
        }
        default: {
          
          throw new TypeError(`"${val6}" is not one of the cases of descriptor-type`);
        }
      }
      dataView(memory0).setInt8(arg4 + 8, enum6, true);
      dataView(memory0).setBigInt64(arg4 + 16, toUint64(v5_1), true);
      dataView(memory0).setBigInt64(arg4 + 24, toUint64(v5_2), true);
      var variant8 = v5_3;
      if (variant8 === null || variant8=== undefined) {
        dataView(memory0).setInt8(arg4 + 32, 0, true);
      } else {
        const e = variant8;
        dataView(memory0).setInt8(arg4 + 32, 1, true);
        var {seconds: v7_0, nanoseconds: v7_1 } = e;
        dataView(memory0).setBigInt64(arg4 + 40, toUint64(v7_0), true);
        dataView(memory0).setInt32(arg4 + 48, toUint32(v7_1), true);
      }
      var variant10 = v5_4;
      if (variant10 === null || variant10=== undefined) {
        dataView(memory0).setInt8(arg4 + 56, 0, true);
      } else {
        const e = variant10;
        dataView(memory0).setInt8(arg4 + 56, 1, true);
        var {seconds: v9_0, nanoseconds: v9_1 } = e;
        dataView(memory0).setBigInt64(arg4 + 64, toUint64(v9_0), true);
        dataView(memory0).setInt32(arg4 + 72, toUint32(v9_1), true);
      }
      var variant12 = v5_5;
      if (variant12 === null || variant12=== undefined) {
        dataView(memory0).setInt8(arg4 + 80, 0, true);
      } else {
        const e = variant12;
        dataView(memory0).setInt8(arg4 + 80, 1, true);
        var {seconds: v11_0, nanoseconds: v11_1 } = e;
        dataView(memory0).setBigInt64(arg4 + 88, toUint64(v11_0), true);
        dataView(memory0).setInt32(arg4 + 96, toUint32(v11_1), true);
      }
      break;
    }
    case 'err': {
      const e = variant14.val;
      dataView(memory0).setInt8(arg4 + 0, 1, true);
      var val13 = e;
      let enum13;
      switch (val13) {
        case 'access': {
          enum13 = 0;
          break;
        }
        case 'would-block': {
          enum13 = 1;
          break;
        }
        case 'already': {
          enum13 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum13 = 3;
          break;
        }
        case 'busy': {
          enum13 = 4;
          break;
        }
        case 'deadlock': {
          enum13 = 5;
          break;
        }
        case 'quota': {
          enum13 = 6;
          break;
        }
        case 'exist': {
          enum13 = 7;
          break;
        }
        case 'file-too-large': {
          enum13 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum13 = 9;
          break;
        }
        case 'in-progress': {
          enum13 = 10;
          break;
        }
        case 'interrupted': {
          enum13 = 11;
          break;
        }
        case 'invalid': {
          enum13 = 12;
          break;
        }
        case 'io': {
          enum13 = 13;
          break;
        }
        case 'is-directory': {
          enum13 = 14;
          break;
        }
        case 'loop': {
          enum13 = 15;
          break;
        }
        case 'too-many-links': {
          enum13 = 16;
          break;
        }
        case 'message-size': {
          enum13 = 17;
          break;
        }
        case 'name-too-long': {
          enum13 = 18;
          break;
        }
        case 'no-device': {
          enum13 = 19;
          break;
        }
        case 'no-entry': {
          enum13 = 20;
          break;
        }
        case 'no-lock': {
          enum13 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum13 = 22;
          break;
        }
        case 'insufficient-space': {
          enum13 = 23;
          break;
        }
        case 'not-directory': {
          enum13 = 24;
          break;
        }
        case 'not-empty': {
          enum13 = 25;
          break;
        }
        case 'not-recoverable': {
          enum13 = 26;
          break;
        }
        case 'unsupported': {
          enum13 = 27;
          break;
        }
        case 'no-tty': {
          enum13 = 28;
          break;
        }
        case 'no-such-device': {
          enum13 = 29;
          break;
        }
        case 'overflow': {
          enum13 = 30;
          break;
        }
        case 'not-permitted': {
          enum13 = 31;
          break;
        }
        case 'pipe': {
          enum13 = 32;
          break;
        }
        case 'read-only': {
          enum13 = 33;
          break;
        }
        case 'invalid-seek': {
          enum13 = 34;
          break;
        }
        case 'text-file-busy': {
          enum13 = 35;
          break;
        }
        case 'cross-device': {
          enum13 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val13}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg4 + 8, enum13, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.stat-at"][Instruction::Return]', {
    funcName: '[method]descriptor.stat-at',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline82(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var flags3 = {
    symlinkFollow: Boolean(arg1 & 1),
  };
  var ptr4 = arg2;
  var len4 = arg3;
  var result4 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr4, len4));
  var handle6 = arg4;
  var rep7 = handleTable19[(handle6 << 1) + 1] & ~T_FLAG;
  var rsc5 = captureTable19.get(rep7);
  if (!rsc5) {
    rsc5 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc5, symbolRscHandle, { writable: true, value: handle6});
    Object.defineProperty(rsc5, symbolRscRep, { writable: true, value: rep7});
  }
  curResourceBorrows.push(rsc5);
  var ptr8 = arg5;
  var len8 = arg6;
  var result8 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr8, len8));
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.link-at"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.link-at');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.linkAt(flags3, result4, rsc5, result8)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.link-at"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant10 = ret;
  switch (variant10.tag) {
    case 'ok': {
      const e = variant10.val;
      dataView(memory0).setInt8(arg7 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant10.val;
      dataView(memory0).setInt8(arg7 + 0, 1, true);
      var val9 = e;
      let enum9;
      switch (val9) {
        case 'access': {
          enum9 = 0;
          break;
        }
        case 'would-block': {
          enum9 = 1;
          break;
        }
        case 'already': {
          enum9 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum9 = 3;
          break;
        }
        case 'busy': {
          enum9 = 4;
          break;
        }
        case 'deadlock': {
          enum9 = 5;
          break;
        }
        case 'quota': {
          enum9 = 6;
          break;
        }
        case 'exist': {
          enum9 = 7;
          break;
        }
        case 'file-too-large': {
          enum9 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum9 = 9;
          break;
        }
        case 'in-progress': {
          enum9 = 10;
          break;
        }
        case 'interrupted': {
          enum9 = 11;
          break;
        }
        case 'invalid': {
          enum9 = 12;
          break;
        }
        case 'io': {
          enum9 = 13;
          break;
        }
        case 'is-directory': {
          enum9 = 14;
          break;
        }
        case 'loop': {
          enum9 = 15;
          break;
        }
        case 'too-many-links': {
          enum9 = 16;
          break;
        }
        case 'message-size': {
          enum9 = 17;
          break;
        }
        case 'name-too-long': {
          enum9 = 18;
          break;
        }
        case 'no-device': {
          enum9 = 19;
          break;
        }
        case 'no-entry': {
          enum9 = 20;
          break;
        }
        case 'no-lock': {
          enum9 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum9 = 22;
          break;
        }
        case 'insufficient-space': {
          enum9 = 23;
          break;
        }
        case 'not-directory': {
          enum9 = 24;
          break;
        }
        case 'not-empty': {
          enum9 = 25;
          break;
        }
        case 'not-recoverable': {
          enum9 = 26;
          break;
        }
        case 'unsupported': {
          enum9 = 27;
          break;
        }
        case 'no-tty': {
          enum9 = 28;
          break;
        }
        case 'no-such-device': {
          enum9 = 29;
          break;
        }
        case 'overflow': {
          enum9 = 30;
          break;
        }
        case 'not-permitted': {
          enum9 = 31;
          break;
        }
        case 'pipe': {
          enum9 = 32;
          break;
        }
        case 'read-only': {
          enum9 = 33;
          break;
        }
        case 'invalid-seek': {
          enum9 = 34;
          break;
        }
        case 'text-file-busy': {
          enum9 = 35;
          break;
        }
        case 'cross-device': {
          enum9 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val9}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg7 + 1, enum9, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.link-at"][Instruction::Return]', {
    funcName: '[method]descriptor.link-at',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline83(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var flags3 = {
    symlinkFollow: Boolean(arg1 & 1),
  };
  var ptr4 = arg2;
  var len4 = arg3;
  var result4 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr4, len4));
  var flags5 = {
    create: Boolean(arg4 & 1),
    directory: Boolean(arg4 & 2),
    exclusive: Boolean(arg4 & 4),
    truncate: Boolean(arg4 & 8),
  };
  var flags6 = {
    read: Boolean(arg5 & 1),
    write: Boolean(arg5 & 2),
    fileIntegritySync: Boolean(arg5 & 4),
    dataIntegritySync: Boolean(arg5 & 8),
    requestedWriteSync: Boolean(arg5 & 16),
    mutateDirectory: Boolean(arg5 & 32),
  };
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.open-at"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.open-at');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.openAt(flags3, result4, flags5, flags6)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.open-at"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant9 = ret;
  switch (variant9.tag) {
    case 'ok': {
      const e = variant9.val;
      dataView(memory0).setInt8(arg6 + 0, 0, true);
      if (!(e instanceof Descriptor)) {
        throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
      }
      var handle7 = e[symbolRscHandle];
      if (!handle7) {
        const rep = e[symbolRscRep] || ++captureCnt19;
        captureTable19.set(rep, e);
        handle7 = rscTableCreateOwn(handleTable19, rep);
      }
      dataView(memory0).setInt32(arg6 + 4, handle7, true);
      break;
    }
    case 'err': {
      const e = variant9.val;
      dataView(memory0).setInt8(arg6 + 0, 1, true);
      var val8 = e;
      let enum8;
      switch (val8) {
        case 'access': {
          enum8 = 0;
          break;
        }
        case 'would-block': {
          enum8 = 1;
          break;
        }
        case 'already': {
          enum8 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum8 = 3;
          break;
        }
        case 'busy': {
          enum8 = 4;
          break;
        }
        case 'deadlock': {
          enum8 = 5;
          break;
        }
        case 'quota': {
          enum8 = 6;
          break;
        }
        case 'exist': {
          enum8 = 7;
          break;
        }
        case 'file-too-large': {
          enum8 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum8 = 9;
          break;
        }
        case 'in-progress': {
          enum8 = 10;
          break;
        }
        case 'interrupted': {
          enum8 = 11;
          break;
        }
        case 'invalid': {
          enum8 = 12;
          break;
        }
        case 'io': {
          enum8 = 13;
          break;
        }
        case 'is-directory': {
          enum8 = 14;
          break;
        }
        case 'loop': {
          enum8 = 15;
          break;
        }
        case 'too-many-links': {
          enum8 = 16;
          break;
        }
        case 'message-size': {
          enum8 = 17;
          break;
        }
        case 'name-too-long': {
          enum8 = 18;
          break;
        }
        case 'no-device': {
          enum8 = 19;
          break;
        }
        case 'no-entry': {
          enum8 = 20;
          break;
        }
        case 'no-lock': {
          enum8 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum8 = 22;
          break;
        }
        case 'insufficient-space': {
          enum8 = 23;
          break;
        }
        case 'not-directory': {
          enum8 = 24;
          break;
        }
        case 'not-empty': {
          enum8 = 25;
          break;
        }
        case 'not-recoverable': {
          enum8 = 26;
          break;
        }
        case 'unsupported': {
          enum8 = 27;
          break;
        }
        case 'no-tty': {
          enum8 = 28;
          break;
        }
        case 'no-such-device': {
          enum8 = 29;
          break;
        }
        case 'overflow': {
          enum8 = 30;
          break;
        }
        case 'not-permitted': {
          enum8 = 31;
          break;
        }
        case 'pipe': {
          enum8 = 32;
          break;
        }
        case 'read-only': {
          enum8 = 33;
          break;
        }
        case 'invalid-seek': {
          enum8 = 34;
          break;
        }
        case 'text-file-busy': {
          enum8 = 35;
          break;
        }
        case 'cross-device': {
          enum8 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val8}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg6 + 4, enum8, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.open-at"][Instruction::Return]', {
    funcName: '[method]descriptor.open-at',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline84(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.remove-directory-at"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.remove-directory-at');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.removeDirectoryAt(result3)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.remove-directory-at"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg3 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg3 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg3 + 1, enum4, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.remove-directory-at"][Instruction::Return]', {
    funcName: '[method]descriptor.remove-directory-at',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline85(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
  var handle5 = arg3;
  var rep6 = handleTable19[(handle5 << 1) + 1] & ~T_FLAG;
  var rsc4 = captureTable19.get(rep6);
  if (!rsc4) {
    rsc4 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc4, symbolRscHandle, { writable: true, value: handle5});
    Object.defineProperty(rsc4, symbolRscRep, { writable: true, value: rep6});
  }
  curResourceBorrows.push(rsc4);
  var ptr7 = arg4;
  var len7 = arg5;
  var result7 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr7, len7));
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.rename-at"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.rename-at');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.renameAt(result3, rsc4, result7)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.rename-at"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant9 = ret;
  switch (variant9.tag) {
    case 'ok': {
      const e = variant9.val;
      dataView(memory0).setInt8(arg6 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant9.val;
      dataView(memory0).setInt8(arg6 + 0, 1, true);
      var val8 = e;
      let enum8;
      switch (val8) {
        case 'access': {
          enum8 = 0;
          break;
        }
        case 'would-block': {
          enum8 = 1;
          break;
        }
        case 'already': {
          enum8 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum8 = 3;
          break;
        }
        case 'busy': {
          enum8 = 4;
          break;
        }
        case 'deadlock': {
          enum8 = 5;
          break;
        }
        case 'quota': {
          enum8 = 6;
          break;
        }
        case 'exist': {
          enum8 = 7;
          break;
        }
        case 'file-too-large': {
          enum8 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum8 = 9;
          break;
        }
        case 'in-progress': {
          enum8 = 10;
          break;
        }
        case 'interrupted': {
          enum8 = 11;
          break;
        }
        case 'invalid': {
          enum8 = 12;
          break;
        }
        case 'io': {
          enum8 = 13;
          break;
        }
        case 'is-directory': {
          enum8 = 14;
          break;
        }
        case 'loop': {
          enum8 = 15;
          break;
        }
        case 'too-many-links': {
          enum8 = 16;
          break;
        }
        case 'message-size': {
          enum8 = 17;
          break;
        }
        case 'name-too-long': {
          enum8 = 18;
          break;
        }
        case 'no-device': {
          enum8 = 19;
          break;
        }
        case 'no-entry': {
          enum8 = 20;
          break;
        }
        case 'no-lock': {
          enum8 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum8 = 22;
          break;
        }
        case 'insufficient-space': {
          enum8 = 23;
          break;
        }
        case 'not-directory': {
          enum8 = 24;
          break;
        }
        case 'not-empty': {
          enum8 = 25;
          break;
        }
        case 'not-recoverable': {
          enum8 = 26;
          break;
        }
        case 'unsupported': {
          enum8 = 27;
          break;
        }
        case 'no-tty': {
          enum8 = 28;
          break;
        }
        case 'no-such-device': {
          enum8 = 29;
          break;
        }
        case 'overflow': {
          enum8 = 30;
          break;
        }
        case 'not-permitted': {
          enum8 = 31;
          break;
        }
        case 'pipe': {
          enum8 = 32;
          break;
        }
        case 'read-only': {
          enum8 = 33;
          break;
        }
        case 'invalid-seek': {
          enum8 = 34;
          break;
        }
        case 'text-file-busy': {
          enum8 = 35;
          break;
        }
        case 'cross-device': {
          enum8 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val8}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg6 + 1, enum8, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.rename-at"][Instruction::Return]', {
    funcName: '[method]descriptor.rename-at',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline86(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.unlink-file-at"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.unlink-file-at');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.unlinkFileAt(result3)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.unlink-file-at"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg3 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg3 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg3 + 1, enum4, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.unlink-file-at"][Instruction::Return]', {
    funcName: '[method]descriptor.unlink-file-at',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline87(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.read-via-stream"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.read-via-stream');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.readViaStream(BigInt.asUintN(64, arg1))};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.read-via-stream"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg2 + 0, 0, true);
      if (!(e instanceof InputStream)) {
        throw new TypeError('Resource error: Not a valid "InputStream" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable2, rep);
      }
      dataView(memory0).setInt32(arg2 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg2 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg2 + 4, enum4, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.read-via-stream"][Instruction::Return]', {
    funcName: '[method]descriptor.read-via-stream',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline88(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.write-via-stream"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.write-via-stream');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.writeViaStream(BigInt.asUintN(64, arg1))};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.write-via-stream"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg2 + 0, 0, true);
      if (!(e instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt3;
        captureTable3.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable3, rep);
      }
      dataView(memory0).setInt32(arg2 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg2 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg2 + 4, enum4, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.write-via-stream"][Instruction::Return]', {
    funcName: '[method]descriptor.write-via-stream',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline89(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.append-via-stream"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.append-via-stream');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.appendViaStream()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.append-via-stream"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      if (!(e instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
      }
      var handle3 = e[symbolRscHandle];
      if (!handle3) {
        const rep = e[symbolRscRep] || ++captureCnt3;
        captureTable3.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable3, rep);
      }
      dataView(memory0).setInt32(arg1 + 4, handle3, true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg1 + 4, enum4, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.append-via-stream"][Instruction::Return]', {
    funcName: '[method]descriptor.append-via-stream',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline90(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.get-type"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.get-type');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.getType()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.get-type"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      var val3 = e;
      let enum3;
      switch (val3) {
        case 'unknown': {
          enum3 = 0;
          break;
        }
        case 'block-device': {
          enum3 = 1;
          break;
        }
        case 'character-device': {
          enum3 = 2;
          break;
        }
        case 'directory': {
          enum3 = 3;
          break;
        }
        case 'fifo': {
          enum3 = 4;
          break;
        }
        case 'symbolic-link': {
          enum3 = 5;
          break;
        }
        case 'regular-file': {
          enum3 = 6;
          break;
        }
        case 'socket': {
          enum3 = 7;
          break;
        }
        default: {
          
          throw new TypeError(`"${val3}" is not one of the cases of descriptor-type`);
        }
      }
      dataView(memory0).setInt8(arg1 + 1, enum3, true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg1 + 1, enum4, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.get-type"][Instruction::Return]', {
    funcName: '[method]descriptor.get-type',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline91(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.stat"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.stat');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.stat()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.stat"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant12 = ret;
  switch (variant12.tag) {
    case 'ok': {
      const e = variant12.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      var {type: v3_0, linkCount: v3_1, size: v3_2, dataAccessTimestamp: v3_3, dataModificationTimestamp: v3_4, statusChangeTimestamp: v3_5 } = e;
      var val4 = v3_0;
      let enum4;
      switch (val4) {
        case 'unknown': {
          enum4 = 0;
          break;
        }
        case 'block-device': {
          enum4 = 1;
          break;
        }
        case 'character-device': {
          enum4 = 2;
          break;
        }
        case 'directory': {
          enum4 = 3;
          break;
        }
        case 'fifo': {
          enum4 = 4;
          break;
        }
        case 'symbolic-link': {
          enum4 = 5;
          break;
        }
        case 'regular-file': {
          enum4 = 6;
          break;
        }
        case 'socket': {
          enum4 = 7;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of descriptor-type`);
        }
      }
      dataView(memory0).setInt8(arg1 + 8, enum4, true);
      dataView(memory0).setBigInt64(arg1 + 16, toUint64(v3_1), true);
      dataView(memory0).setBigInt64(arg1 + 24, toUint64(v3_2), true);
      var variant6 = v3_3;
      if (variant6 === null || variant6=== undefined) {
        dataView(memory0).setInt8(arg1 + 32, 0, true);
      } else {
        const e = variant6;
        dataView(memory0).setInt8(arg1 + 32, 1, true);
        var {seconds: v5_0, nanoseconds: v5_1 } = e;
        dataView(memory0).setBigInt64(arg1 + 40, toUint64(v5_0), true);
        dataView(memory0).setInt32(arg1 + 48, toUint32(v5_1), true);
      }
      var variant8 = v3_4;
      if (variant8 === null || variant8=== undefined) {
        dataView(memory0).setInt8(arg1 + 56, 0, true);
      } else {
        const e = variant8;
        dataView(memory0).setInt8(arg1 + 56, 1, true);
        var {seconds: v7_0, nanoseconds: v7_1 } = e;
        dataView(memory0).setBigInt64(arg1 + 64, toUint64(v7_0), true);
        dataView(memory0).setInt32(arg1 + 72, toUint32(v7_1), true);
      }
      var variant10 = v3_5;
      if (variant10 === null || variant10=== undefined) {
        dataView(memory0).setInt8(arg1 + 80, 0, true);
      } else {
        const e = variant10;
        dataView(memory0).setInt8(arg1 + 80, 1, true);
        var {seconds: v9_0, nanoseconds: v9_1 } = e;
        dataView(memory0).setBigInt64(arg1 + 88, toUint64(v9_0), true);
        dataView(memory0).setInt32(arg1 + 96, toUint32(v9_1), true);
      }
      break;
    }
    case 'err': {
      const e = variant12.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      var val11 = e;
      let enum11;
      switch (val11) {
        case 'access': {
          enum11 = 0;
          break;
        }
        case 'would-block': {
          enum11 = 1;
          break;
        }
        case 'already': {
          enum11 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum11 = 3;
          break;
        }
        case 'busy': {
          enum11 = 4;
          break;
        }
        case 'deadlock': {
          enum11 = 5;
          break;
        }
        case 'quota': {
          enum11 = 6;
          break;
        }
        case 'exist': {
          enum11 = 7;
          break;
        }
        case 'file-too-large': {
          enum11 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum11 = 9;
          break;
        }
        case 'in-progress': {
          enum11 = 10;
          break;
        }
        case 'interrupted': {
          enum11 = 11;
          break;
        }
        case 'invalid': {
          enum11 = 12;
          break;
        }
        case 'io': {
          enum11 = 13;
          break;
        }
        case 'is-directory': {
          enum11 = 14;
          break;
        }
        case 'loop': {
          enum11 = 15;
          break;
        }
        case 'too-many-links': {
          enum11 = 16;
          break;
        }
        case 'message-size': {
          enum11 = 17;
          break;
        }
        case 'name-too-long': {
          enum11 = 18;
          break;
        }
        case 'no-device': {
          enum11 = 19;
          break;
        }
        case 'no-entry': {
          enum11 = 20;
          break;
        }
        case 'no-lock': {
          enum11 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum11 = 22;
          break;
        }
        case 'insufficient-space': {
          enum11 = 23;
          break;
        }
        case 'not-directory': {
          enum11 = 24;
          break;
        }
        case 'not-empty': {
          enum11 = 25;
          break;
        }
        case 'not-recoverable': {
          enum11 = 26;
          break;
        }
        case 'unsupported': {
          enum11 = 27;
          break;
        }
        case 'no-tty': {
          enum11 = 28;
          break;
        }
        case 'no-such-device': {
          enum11 = 29;
          break;
        }
        case 'overflow': {
          enum11 = 30;
          break;
        }
        case 'not-permitted': {
          enum11 = 31;
          break;
        }
        case 'pipe': {
          enum11 = 32;
          break;
        }
        case 'read-only': {
          enum11 = 33;
          break;
        }
        case 'invalid-seek': {
          enum11 = 34;
          break;
        }
        case 'text-file-busy': {
          enum11 = 35;
          break;
        }
        case 'cross-device': {
          enum11 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val11}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg1 + 8, enum11, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.stat"][Instruction::Return]', {
    funcName: '[method]descriptor.stat',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline92(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.readlink-at"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.readlink-at');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.readlinkAt(result3)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.readlink-at"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg3 + 0, 0, true);
      var ptr4 = utf8Encode(e, realloc1, memory0);
      var len4 = utf8EncodedLen;
      dataView(memory0).setUint32(arg3 + 8, len4, true);
      dataView(memory0).setUint32(arg3 + 4, ptr4, true);
      break;
    }
    case 'err': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg3 + 0, 1, true);
      var val5 = e;
      let enum5;
      switch (val5) {
        case 'access': {
          enum5 = 0;
          break;
        }
        case 'would-block': {
          enum5 = 1;
          break;
        }
        case 'already': {
          enum5 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum5 = 3;
          break;
        }
        case 'busy': {
          enum5 = 4;
          break;
        }
        case 'deadlock': {
          enum5 = 5;
          break;
        }
        case 'quota': {
          enum5 = 6;
          break;
        }
        case 'exist': {
          enum5 = 7;
          break;
        }
        case 'file-too-large': {
          enum5 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum5 = 9;
          break;
        }
        case 'in-progress': {
          enum5 = 10;
          break;
        }
        case 'interrupted': {
          enum5 = 11;
          break;
        }
        case 'invalid': {
          enum5 = 12;
          break;
        }
        case 'io': {
          enum5 = 13;
          break;
        }
        case 'is-directory': {
          enum5 = 14;
          break;
        }
        case 'loop': {
          enum5 = 15;
          break;
        }
        case 'too-many-links': {
          enum5 = 16;
          break;
        }
        case 'message-size': {
          enum5 = 17;
          break;
        }
        case 'name-too-long': {
          enum5 = 18;
          break;
        }
        case 'no-device': {
          enum5 = 19;
          break;
        }
        case 'no-entry': {
          enum5 = 20;
          break;
        }
        case 'no-lock': {
          enum5 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum5 = 22;
          break;
        }
        case 'insufficient-space': {
          enum5 = 23;
          break;
        }
        case 'not-directory': {
          enum5 = 24;
          break;
        }
        case 'not-empty': {
          enum5 = 25;
          break;
        }
        case 'not-recoverable': {
          enum5 = 26;
          break;
        }
        case 'unsupported': {
          enum5 = 27;
          break;
        }
        case 'no-tty': {
          enum5 = 28;
          break;
        }
        case 'no-such-device': {
          enum5 = 29;
          break;
        }
        case 'overflow': {
          enum5 = 30;
          break;
        }
        case 'not-permitted': {
          enum5 = 31;
          break;
        }
        case 'pipe': {
          enum5 = 32;
          break;
        }
        case 'read-only': {
          enum5 = 33;
          break;
        }
        case 'invalid-seek': {
          enum5 = 34;
          break;
        }
        case 'text-file-busy': {
          enum5 = 35;
          break;
        }
        case 'cross-device': {
          enum5 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val5}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg3 + 4, enum5, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.readlink-at"][Instruction::Return]', {
    funcName: '[method]descriptor.readlink-at',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline93(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.metadata-hash"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.metadata-hash');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.metadataHash()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.metadata-hash"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      var {lower: v3_0, upper: v3_1 } = e;
      dataView(memory0).setBigInt64(arg1 + 8, toUint64(v3_0), true);
      dataView(memory0).setBigInt64(arg1 + 16, toUint64(v3_1), true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg1 + 8, enum4, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.metadata-hash"][Instruction::Return]', {
    funcName: '[method]descriptor.metadata-hash',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline94(arg0, arg1, arg2, arg3, arg4) {
  var handle1 = arg0;
  var rep2 = handleTable19[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable19.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var flags3 = {
    symlinkFollow: Boolean(arg1 & 1),
  };
  var ptr4 = arg2;
  var len4 = arg3;
  var result4 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr4, len4));
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.metadata-hash-at"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]descriptor.metadata-hash-at');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.metadataHashAt(flags3, result4)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.metadata-hash-at"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant7 = ret;
  switch (variant7.tag) {
    case 'ok': {
      const e = variant7.val;
      dataView(memory0).setInt8(arg4 + 0, 0, true);
      var {lower: v5_0, upper: v5_1 } = e;
      dataView(memory0).setBigInt64(arg4 + 8, toUint64(v5_0), true);
      dataView(memory0).setBigInt64(arg4 + 16, toUint64(v5_1), true);
      break;
    }
    case 'err': {
      const e = variant7.val;
      dataView(memory0).setInt8(arg4 + 0, 1, true);
      var val6 = e;
      let enum6;
      switch (val6) {
        case 'access': {
          enum6 = 0;
          break;
        }
        case 'would-block': {
          enum6 = 1;
          break;
        }
        case 'already': {
          enum6 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum6 = 3;
          break;
        }
        case 'busy': {
          enum6 = 4;
          break;
        }
        case 'deadlock': {
          enum6 = 5;
          break;
        }
        case 'quota': {
          enum6 = 6;
          break;
        }
        case 'exist': {
          enum6 = 7;
          break;
        }
        case 'file-too-large': {
          enum6 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum6 = 9;
          break;
        }
        case 'in-progress': {
          enum6 = 10;
          break;
        }
        case 'interrupted': {
          enum6 = 11;
          break;
        }
        case 'invalid': {
          enum6 = 12;
          break;
        }
        case 'io': {
          enum6 = 13;
          break;
        }
        case 'is-directory': {
          enum6 = 14;
          break;
        }
        case 'loop': {
          enum6 = 15;
          break;
        }
        case 'too-many-links': {
          enum6 = 16;
          break;
        }
        case 'message-size': {
          enum6 = 17;
          break;
        }
        case 'name-too-long': {
          enum6 = 18;
          break;
        }
        case 'no-device': {
          enum6 = 19;
          break;
        }
        case 'no-entry': {
          enum6 = 20;
          break;
        }
        case 'no-lock': {
          enum6 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum6 = 22;
          break;
        }
        case 'insufficient-space': {
          enum6 = 23;
          break;
        }
        case 'not-directory': {
          enum6 = 24;
          break;
        }
        case 'not-empty': {
          enum6 = 25;
          break;
        }
        case 'not-recoverable': {
          enum6 = 26;
          break;
        }
        case 'unsupported': {
          enum6 = 27;
          break;
        }
        case 'no-tty': {
          enum6 = 28;
          break;
        }
        case 'no-such-device': {
          enum6 = 29;
          break;
        }
        case 'overflow': {
          enum6 = 30;
          break;
        }
        case 'not-permitted': {
          enum6 = 31;
          break;
        }
        case 'pipe': {
          enum6 = 32;
          break;
        }
        case 'read-only': {
          enum6 = 33;
          break;
        }
        case 'invalid-seek': {
          enum6 = 34;
          break;
        }
        case 'text-file-busy': {
          enum6 = 35;
          break;
        }
        case 'cross-device': {
          enum6 = 36;
          break;
        }
        default: {
          
          throw new TypeError(`"${val6}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg4 + 8, enum6, true);
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.6", function="[method]descriptor.metadata-hash-at"][Instruction::Return]', {
    funcName: '[method]descriptor.metadata-hash-at',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline95(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable2.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(InputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.blocking-read"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]input-stream.blocking-read');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.blockingRead(BigInt.asUintN(64, arg1))};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.blocking-read"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg2 + 0, 0, true);
      var val3 = e;
      var len3 = val3.byteLength;
      var ptr3 = realloc1(0, 0, 1, len3 * 1);
      var src3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, len3 * 1);
      (new Uint8Array(memory0.buffer, ptr3, len3 * 1)).set(src3);
      dataView(memory0).setUint32(arg2 + 8, len3, true);
      dataView(memory0).setUint32(arg2 + 4, ptr3, true);
      break;
    }
    case 'err': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg2 + 0, 1, true);
      var variant5 = e;
      switch (variant5.tag) {
        case 'last-operation-failed': {
          const e = variant5.val;
          dataView(memory0).setInt8(arg2 + 4, 0, true);
          if (!(e instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid "Error" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep = e[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, e);
            handle4 = rscTableCreateOwn(handleTable1, rep);
          }
          dataView(memory0).setInt32(arg2 + 8, handle4, true);
          break;
        }
        case 'closed': {
          dataView(memory0).setInt8(arg2 + 4, 1, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.blocking-read"][Instruction::Return]', {
    funcName: '[method]input-stream.blocking-read',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline96(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable2.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(InputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.read"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]input-stream.read');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.read(BigInt.asUintN(64, arg1))};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.read"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg2 + 0, 0, true);
      var val3 = e;
      var len3 = val3.byteLength;
      var ptr3 = realloc1(0, 0, 1, len3 * 1);
      var src3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, len3 * 1);
      (new Uint8Array(memory0.buffer, ptr3, len3 * 1)).set(src3);
      dataView(memory0).setUint32(arg2 + 8, len3, true);
      dataView(memory0).setUint32(arg2 + 4, ptr3, true);
      break;
    }
    case 'err': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg2 + 0, 1, true);
      var variant5 = e;
      switch (variant5.tag) {
        case 'last-operation-failed': {
          const e = variant5.val;
          dataView(memory0).setInt8(arg2 + 4, 0, true);
          if (!(e instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid "Error" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep = e[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, e);
            handle4 = rscTableCreateOwn(handleTable1, rep);
          }
          dataView(memory0).setInt32(arg2 + 8, handle4, true);
          break;
        }
        case 'closed': {
          dataView(memory0).setInt8(arg2 + 4, 1, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]input-stream.read"][Instruction::Return]', {
    funcName: '[method]input-stream.read',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline97(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.check-write"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]output-stream.check-write');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.checkWrite()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.check-write"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      dataView(memory0).setBigInt64(arg1 + 8, toUint64(e), true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      var variant4 = e;
      switch (variant4.tag) {
        case 'last-operation-failed': {
          const e = variant4.val;
          dataView(memory0).setInt8(arg1 + 8, 0, true);
          if (!(e instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid "Error" resource.');
          }
          var handle3 = e[symbolRscHandle];
          if (!handle3) {
            const rep = e[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, e);
            handle3 = rscTableCreateOwn(handleTable1, rep);
          }
          dataView(memory0).setInt32(arg1 + 12, handle3, true);
          break;
        }
        case 'closed': {
          dataView(memory0).setInt8(arg1 + 8, 1, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant4.tag)}\` (received \`${variant4}\`) specified for \`StreamError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.check-write"][Instruction::Return]', {
    funcName: '[method]output-stream.check-write',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline98(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-flush"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]output-stream.blocking-flush');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.blockingFlush()};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-flush"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      var variant4 = e;
      switch (variant4.tag) {
        case 'last-operation-failed': {
          const e = variant4.val;
          dataView(memory0).setInt8(arg1 + 4, 0, true);
          if (!(e instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid "Error" resource.');
          }
          var handle3 = e[symbolRscHandle];
          if (!handle3) {
            const rep = e[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, e);
            handle3 = rscTableCreateOwn(handleTable1, rep);
          }
          dataView(memory0).setInt32(arg1 + 8, handle3, true);
          break;
        }
        case 'closed': {
          dataView(memory0).setInt8(arg1 + 4, 1, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant4.tag)}\` (received \`${variant4}\`) specified for \`StreamError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-flush"][Instruction::Return]', {
    funcName: '[method]output-stream.blocking-flush',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline99(arg0) {
  _debugLog('[iface="wasi:filesystem/preopens@0.2.6", function="get-directories"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-directories');
  const ret = getDirectories();
  _debugLog('[iface="wasi:filesystem/preopens@0.2.6", function="get-directories"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var vec3 = ret;
  var len3 = vec3.length;
  var result3 = realloc1(0, 0, 4, len3 * 12);
  for (let i = 0; i < vec3.length; i++) {
    const e = vec3[i];
    const base = result3 + i * 12;var [tuple0_0, tuple0_1] = e;
    if (!(tuple0_0 instanceof Descriptor)) {
      throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
    }
    var handle1 = tuple0_0[symbolRscHandle];
    if (!handle1) {
      const rep = tuple0_0[symbolRscRep] || ++captureCnt19;
      captureTable19.set(rep, tuple0_0);
      handle1 = rscTableCreateOwn(handleTable19, rep);
    }
    dataView(memory0).setInt32(base + 0, handle1, true);
    var ptr2 = utf8Encode(tuple0_1, realloc1, memory0);
    var len2 = utf8EncodedLen;
    dataView(memory0).setUint32(base + 8, len2, true);
    dataView(memory0).setUint32(base + 4, ptr2, true);
  }
  dataView(memory0).setUint32(arg0 + 4, len3, true);
  dataView(memory0).setUint32(arg0 + 0, result3, true);
  _debugLog('[iface="wasi:filesystem/preopens@0.2.6", function="get-directories"][Instruction::Return]', {
    funcName: 'get-directories',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

const handleTable16 = [T_FLAG, 0];
const captureTable16= new Map();
let captureCnt16 = 0;
handleTables[16] = handleTable16;

function trampoline100(arg0) {
  _debugLog('[iface="wasi:cli/terminal-stdin@0.2.6", function="get-terminal-stdin"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-terminal-stdin');
  const ret = getTerminalStdin();
  _debugLog('[iface="wasi:cli/terminal-stdin@0.2.6", function="get-terminal-stdin"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var variant1 = ret;
  if (variant1 === null || variant1=== undefined) {
    dataView(memory0).setInt8(arg0 + 0, 0, true);
  } else {
    const e = variant1;
    dataView(memory0).setInt8(arg0 + 0, 1, true);
    if (!(e instanceof TerminalInput)) {
      throw new TypeError('Resource error: Not a valid "TerminalInput" resource.');
    }
    var handle0 = e[symbolRscHandle];
    if (!handle0) {
      const rep = e[symbolRscRep] || ++captureCnt16;
      captureTable16.set(rep, e);
      handle0 = rscTableCreateOwn(handleTable16, rep);
    }
    dataView(memory0).setInt32(arg0 + 4, handle0, true);
  }
  _debugLog('[iface="wasi:cli/terminal-stdin@0.2.6", function="get-terminal-stdin"][Instruction::Return]', {
    funcName: 'get-terminal-stdin',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

const handleTable17 = [T_FLAG, 0];
const captureTable17= new Map();
let captureCnt17 = 0;
handleTables[17] = handleTable17;

function trampoline101(arg0) {
  _debugLog('[iface="wasi:cli/terminal-stdout@0.2.6", function="get-terminal-stdout"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-terminal-stdout');
  const ret = getTerminalStdout();
  _debugLog('[iface="wasi:cli/terminal-stdout@0.2.6", function="get-terminal-stdout"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var variant1 = ret;
  if (variant1 === null || variant1=== undefined) {
    dataView(memory0).setInt8(arg0 + 0, 0, true);
  } else {
    const e = variant1;
    dataView(memory0).setInt8(arg0 + 0, 1, true);
    if (!(e instanceof TerminalOutput)) {
      throw new TypeError('Resource error: Not a valid "TerminalOutput" resource.');
    }
    var handle0 = e[symbolRscHandle];
    if (!handle0) {
      const rep = e[symbolRscRep] || ++captureCnt17;
      captureTable17.set(rep, e);
      handle0 = rscTableCreateOwn(handleTable17, rep);
    }
    dataView(memory0).setInt32(arg0 + 4, handle0, true);
  }
  _debugLog('[iface="wasi:cli/terminal-stdout@0.2.6", function="get-terminal-stdout"][Instruction::Return]', {
    funcName: 'get-terminal-stdout',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline102(arg0) {
  _debugLog('[iface="wasi:cli/terminal-stderr@0.2.6", function="get-terminal-stderr"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-terminal-stderr');
  const ret = getTerminalStderr();
  _debugLog('[iface="wasi:cli/terminal-stderr@0.2.6", function="get-terminal-stderr"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var variant1 = ret;
  if (variant1 === null || variant1=== undefined) {
    dataView(memory0).setInt8(arg0 + 0, 0, true);
  } else {
    const e = variant1;
    dataView(memory0).setInt8(arg0 + 0, 1, true);
    if (!(e instanceof TerminalOutput)) {
      throw new TypeError('Resource error: Not a valid "TerminalOutput" resource.');
    }
    var handle0 = e[symbolRscHandle];
    if (!handle0) {
      const rep = e[symbolRscRep] || ++captureCnt17;
      captureTable17.set(rep, e);
      handle0 = rscTableCreateOwn(handleTable17, rep);
    }
    dataView(memory0).setInt32(arg0 + 4, handle0, true);
  }
  _debugLog('[iface="wasi:cli/terminal-stderr@0.2.6", function="get-terminal-stderr"][Instruction::Return]', {
    funcName: 'get-terminal-stderr',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

let exports3;
let postReturn0;
function trampoline3(handle) {
  const handleEntry = rscTableRemove(handleTable15, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable15.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable15.delete(handleEntry.rep);
    } else if (LazyProcess[symbolCabiDispose]) {
      LazyProcess[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline10(handle) {
  const handleEntry = rscTableRemove(handleTable8, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable8.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable8.delete(handleEntry.rep);
    } else if (IncomingResponse[symbolCabiDispose]) {
      IncomingResponse[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline11(handle) {
  const handleEntry = rscTableRemove(handleTable7, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable7.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable7.delete(handleEntry.rep);
    } else if (FutureIncomingResponse[symbolCabiDispose]) {
      FutureIncomingResponse[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline14(handle) {
  const handleEntry = rscTableRemove(handleTable0, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable0.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable0.delete(handleEntry.rep);
    } else if (Pollable[symbolCabiDispose]) {
      Pollable[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline15(handle) {
  const handleEntry = rscTableRemove(handleTable4, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable4.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable4.delete(handleEntry.rep);
    } else if (Fields[symbolCabiDispose]) {
      Fields[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline16(handle) {
  const handleEntry = rscTableRemove(handleTable2, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable2.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable2.delete(handleEntry.rep);
    } else if (InputStream[symbolCabiDispose]) {
      InputStream[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline17(handle) {
  const handleEntry = rscTableRemove(handleTable1, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable1.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable1.delete(handleEntry.rep);
    } else if (Error$1[symbolCabiDispose]) {
      Error$1[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline18(handle) {
  const handleEntry = rscTableRemove(handleTable9, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable9.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable9.delete(handleEntry.rep);
    } else if (IncomingBody[symbolCabiDispose]) {
      IncomingBody[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline19(handle) {
  const handleEntry = rscTableRemove(handleTable6, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable6.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable6.delete(handleEntry.rep);
    } else if (OutgoingBody[symbolCabiDispose]) {
      OutgoingBody[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline20(handle) {
  const handleEntry = rscTableRemove(handleTable3, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable3.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable3.delete(handleEntry.rep);
    } else if (OutputStream[symbolCabiDispose]) {
      OutputStream[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline21(handle) {
  const handleEntry = rscTableRemove(handleTable5, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable5.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable5.delete(handleEntry.rep);
    } else if (OutgoingRequest[symbolCabiDispose]) {
      OutgoingRequest[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline24(handle) {
  const handleEntry = rscTableRemove(handleTable11, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable11.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable11.delete(handleEntry.rep);
    } else if (FutureTrailers[symbolCabiDispose]) {
      FutureTrailers[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline27(handle) {
  const handleEntry = rscTableRemove(handleTable12, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable12.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable12.delete(handleEntry.rep);
    } else if (OutgoingResponse[symbolCabiDispose]) {
      OutgoingResponse[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline28(handle) {
  const handleEntry = rscTableRemove(handleTable13, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable13.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable13.delete(handleEntry.rep);
    } else if (ResponseOutparam[symbolCabiDispose]) {
      ResponseOutparam[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline29(handle) {
  const handleEntry = rscTableRemove(handleTable10, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable10.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable10.delete(handleEntry.rep);
    } else if (IncomingRequest[symbolCabiDispose]) {
      IncomingRequest[symbolCabiDispose](handleEntry.rep);
    }
  }
}
const handleTable20 = [T_FLAG, 0];
const captureTable20= new Map();
let captureCnt20 = 0;
handleTables[20] = handleTable20;
function trampoline33(handle) {
  const handleEntry = rscTableRemove(handleTable20, handle);
  if (handleEntry.own) {
    throw new TypeError('unreachable trampoline for resource [ResourceIndex(20)]')
  }
}
const handleTable21 = [T_FLAG, 0];
const captureTable21= new Map();
let captureCnt21 = 0;
handleTables[21] = handleTable21;
function trampoline34(handle) {
  const handleEntry = rscTableRemove(handleTable21, handle);
  if (handleEntry.own) {
    throw new TypeError('unreachable trampoline for resource [ResourceIndex(21)]')
  }
}
const handleTable22 = [T_FLAG, 0];
const captureTable22= new Map();
let captureCnt22 = 0;
handleTables[22] = handleTable22;
function trampoline35(handle) {
  const handleEntry = rscTableRemove(handleTable22, handle);
  if (handleEntry.own) {
    throw new TypeError('unreachable trampoline for resource [ResourceIndex(22)]')
  }
}
const handleTable23 = [T_FLAG, 0];
const captureTable23= new Map();
let captureCnt23 = 0;
handleTables[23] = handleTable23;
function trampoline36(handle) {
  const handleEntry = rscTableRemove(handleTable23, handle);
  if (handleEntry.own) {
    throw new TypeError('unreachable trampoline for resource [ResourceIndex(23)]')
  }
}
function trampoline37(handle) {
  const handleEntry = rscTableRemove(handleTable18, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable18.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable18.delete(handleEntry.rep);
    } else if (DirectoryEntryStream[symbolCabiDispose]) {
      DirectoryEntryStream[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline38(handle) {
  const handleEntry = rscTableRemove(handleTable19, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable19.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable19.delete(handleEntry.rep);
    } else if (Descriptor[symbolCabiDispose]) {
      Descriptor[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline39(handle) {
  const handleEntry = rscTableRemove(handleTable16, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable16.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable16.delete(handleEntry.rep);
    } else if (TerminalInput[symbolCabiDispose]) {
      TerminalInput[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline40(handle) {
  const handleEntry = rscTableRemove(handleTable17, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable17.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable17.delete(handleEntry.rep);
    } else if (TerminalOutput[symbolCabiDispose]) {
      TerminalOutput[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let incomingHandler024Handle;

function handle$1(arg0, arg1) {
  if (!_initialized) throwUninitialized();
  if (!(arg0 instanceof IncomingRequest)) {
    throw new TypeError('Resource error: Not a valid "IncomingRequest" resource.');
  }
  var handle0 = arg0[symbolRscHandle];
  if (!handle0) {
    const rep = arg0[symbolRscRep] || ++captureCnt10;
    captureTable10.set(rep, arg0);
    handle0 = rscTableCreateOwn(handleTable10, rep);
  }
  if (!(arg1 instanceof ResponseOutparam)) {
    throw new TypeError('Resource error: Not a valid "ResponseOutparam" resource.');
  }
  var handle1 = arg1[symbolRscHandle];
  if (!handle1) {
    const rep = arg1[symbolRscRep] || ++captureCnt13;
    captureTable13.set(rep, arg1);
    handle1 = rscTableCreateOwn(handleTable13, rep);
  }
  _debugLog('[iface="wasi:http/incoming-handler@0.2.4", function="handle"][Instruction::CallWasm] enter', {
    funcName: 'handle',
    paramCount: 2,
    async: false,
    postReturn: false,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'incomingHandler024Handle');
  incomingHandler024Handle(handle0, handle1);
  endCurrentTask(0);
  _debugLog('[iface="wasi:http/incoming-handler@0.2.4", function="handle"][Instruction::Return]', {
    funcName: 'handle',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}
let command010Run;

function run(arg0, arg1, arg2, arg3, arg4, arg5) {
  if (!_initialized) throwUninitialized();
  var ptr0 = utf8Encode(arg0, realloc0, memory0);
  var len0 = utf8EncodedLen;
  var vec2 = arg1;
  var len2 = vec2.length;
  var result2 = realloc0(0, 0, 4, len2 * 8);
  for (let i = 0; i < vec2.length; i++) {
    const e = vec2[i];
    const base = result2 + i * 8;var ptr1 = utf8Encode(e, realloc0, memory0);
    var len1 = utf8EncodedLen;
    dataView(memory0).setUint32(base + 4, len1, true);
    dataView(memory0).setUint32(base + 0, ptr1, true);
  }
  var {cwd: v3_0, vars: v3_1 } = arg2;
  var ptr4 = utf8Encode(v3_0, realloc0, memory0);
  var len4 = utf8EncodedLen;
  var vec8 = v3_1;
  var len8 = vec8.length;
  var result8 = realloc0(0, 0, 4, len8 * 16);
  for (let i = 0; i < vec8.length; i++) {
    const e = vec8[i];
    const base = result8 + i * 16;var [tuple5_0, tuple5_1] = e;
    var ptr6 = utf8Encode(tuple5_0, realloc0, memory0);
    var len6 = utf8EncodedLen;
    dataView(memory0).setUint32(base + 4, len6, true);
    dataView(memory0).setUint32(base + 0, ptr6, true);
    var ptr7 = utf8Encode(tuple5_1, realloc0, memory0);
    var len7 = utf8EncodedLen;
    dataView(memory0).setUint32(base + 12, len7, true);
    dataView(memory0).setUint32(base + 8, ptr7, true);
  }
  if (!(arg3 instanceof InputStream)) {
    throw new TypeError('Resource error: Not a valid "InputStream" resource.');
  }
  var handle9 = arg3[symbolRscHandle];
  if (!handle9) {
    const rep = arg3[symbolRscRep] || ++captureCnt2;
    captureTable2.set(rep, arg3);
    handle9 = rscTableCreateOwn(handleTable2, rep);
  }
  if (!(arg4 instanceof OutputStream)) {
    throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
  }
  var handle10 = arg4[symbolRscHandle];
  if (!handle10) {
    const rep = arg4[symbolRscRep] || ++captureCnt3;
    captureTable3.set(rep, arg4);
    handle10 = rscTableCreateOwn(handleTable3, rep);
  }
  if (!(arg5 instanceof OutputStream)) {
    throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
  }
  var handle11 = arg5[symbolRscHandle];
  if (!handle11) {
    const rep = arg5[symbolRscRep] || ++captureCnt3;
    captureTable3.set(rep, arg5);
    handle11 = rscTableCreateOwn(handleTable3, rep);
  }
  _debugLog('[iface="shell:unix/command@0.1.0", function="run"][Instruction::CallWasm] enter', {
    funcName: 'run',
    paramCount: 11,
    async: false,
    postReturn: false,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'command010Run');
  const ret = command010Run(ptr0, len0, result2, len2, ptr4, len4, result8, len8, handle9, handle10, handle11);
  endCurrentTask(0);
  _debugLog('[iface="shell:unix/command@0.1.0", function="run"][Instruction::Return]', {
    funcName: 'run',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return ret;
}
let command010ListCommands;

function listCommands() {
  if (!_initialized) throwUninitialized();
  _debugLog('[iface="shell:unix/command@0.1.0", function="list-commands"][Instruction::CallWasm] enter', {
    funcName: 'list-commands',
    paramCount: 0,
    async: false,
    postReturn: true,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'command010ListCommands');
  const ret = command010ListCommands();
  endCurrentTask(0);
  var len1 = dataView(memory0).getUint32(ret + 4, true);
  var base1 = dataView(memory0).getUint32(ret + 0, true);
  var result1 = [];
  for (let i = 0; i < len1; i++) {
    const base = base1 + i * 8;
    var ptr0 = dataView(memory0).getUint32(base + 0, true);
    var len0 = dataView(memory0).getUint32(base + 4, true);
    var result0 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr0, len0));
    result1.push(result0);
  }
  _debugLog('[iface="shell:unix/command@0.1.0", function="list-commands"][Instruction::Return]', {
    funcName: 'list-commands',
    paramCount: 1,
    async: false,
    postReturn: true
  });
  const retCopy = result1;
  
  let cstate = getOrCreateAsyncState(0);
  cstate.mayLeave = false;
  postReturn0(ret);
  cstate.mayLeave = true;
  return retCopy;
  
}
let run026Run;

function run$1() {
  if (!_initialized) throwUninitialized();
  _debugLog('[iface="wasi:cli/run@0.2.6", function="run"][Instruction::CallWasm] enter', {
    funcName: 'run',
    paramCount: 0,
    async: false,
    postReturn: false,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'run026Run');
  const ret = run026Run();
  endCurrentTask(0);
  let variant0;
  if (ret) {
    variant0= {
      tag: 'err',
      val: undefined
    };
  } else {
    variant0= {
      tag: 'ok',
      val: undefined
    };
  }
  _debugLog('[iface="wasi:cli/run@0.2.6", function="run"][Instruction::Return]', {
    funcName: 'run',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  const retCopy = variant0;
  
  if (typeof retCopy === 'object' && retCopy.tag === 'err') {
    throw new ComponentError(retCopy.val);
  }
  return retCopy.val;
  
}

let _initialized = false;
export const $init = (() => {
  let gen = (function* _initGenerator () {
    const module0 = fetchCompile(new URL('./ts-runtime-mcp.core.wasm', import.meta.url));
    const module1 = fetchCompile(new URL('./ts-runtime-mcp.core2.wasm', import.meta.url));
    const module2 = fetchCompile(new URL('./ts-runtime-mcp.core3.wasm', import.meta.url));
    const module3 = base64Compile('AGFzbQEAAAAB6wEdYAN/f38AYAp/f39/f39/f39/AX9gA39/fwF+YAJ/fwBgA39+fwBgAn5/AGAGf39/f39/AX9gBH9+f38Bf2ACf34Bf2ADf39/AX9gBX9/f35/AX9gB39/f39/f38Bf2ACf38Bf2AFf39/f38Bf2AEf39/fwF/YAl/f39/f35+f38Bf2ABfwF/YAF/AGAGf39/f39/AGAEf39/fwF/YAV/f39/fwF/YAR/f39/AGAJf39/f35/f39/AGAEf39/fwBgAX8AYAV/f39/fwBgCH9/f39/f39/AGAHf39/f39/fwBgB39/f39/f38AAv4DVQABMAAAAAExAAEAATIAAgABMwADAAE0AAQAATUABAABNgAFAAE3AAYAATgABwABOQAIAAIxMAAJAAIxMQAKAAIxMgALAAIxMwAGAAIxNAAMAAIxNQAJAAIxNgANAAIxNwAJAAIxOAAOAAIxOQAMAAIyMAAOAAIyMQAPAAIyMgAMAAIyMwAMAAIyNAAQAAIyNQAMAAIyNgAJAAIyNwARAAIyOAAQAAIyOQASAAIzMAATAAIzMQAUAAIzMgATAAIzMwATAAIzNAADAAIzNQADAAIzNgADAAIzNwADAAIzOAADAAIzOQAVAAI0MAASAAI0MQADAAI0MgADAAI0MwADAAI0NAADAAI0NQAWAAI0NgAXAAI0NwAEAAI0OAAEAAI0OQAXAAI1MAAVAAI1MQAYAAI1MgADAAI1MwAYAAI1NAAYAAI1NQAEAAI1NgADAAI1NwADAAI1OAADAAI1OQAXAAI2MAAZAAI2MQAaAAI2MgAbAAI2MwAXAAI2NAAcAAI2NQAXAAI2NgAEAAI2NwAEAAI2OAADAAI2OQADAAI3MAADAAI3MQAXAAI3MgADAAI3MwAZAAI3NAAEAAI3NQAEAAI3NgADAAI3NwAXAAI3OAADAAI3OQAXAAI4MAAYAAI4MQAYAAI4MgAYAAI4MwAYAAgkaW1wb3J0cwFwAVRUCVoBAEEAC1QAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlMALwlwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQENd2l0LWNvbXBvbmVudAcwLjIzOS4wABwEbmFtZQAVFHdpdC1jb21wb25lbnQ6Zml4dXBz');
    ({ exports: exports0 } = yield instantiateCore(yield module2));
    ({ exports: exports1 } = yield instantiateCore(yield module0, {
      'mcp:module-loader/loader@0.1.0': {
        '[method]lazy-process.close-stdin': trampoline2,
        '[method]lazy-process.get-ready-pollable': trampoline0,
        '[method]lazy-process.is-ready': trampoline1,
        '[method]lazy-process.read-stderr': exports0['4'],
        '[method]lazy-process.read-stdout': exports0['5'],
        '[method]lazy-process.try-wait': exports0['3'],
        '[method]lazy-process.write-stdin': exports0['2'],
        '[resource-drop]lazy-process': trampoline3,
        'get-lazy-module': exports0['0'],
        'spawn-lazy-command': exports0['1'],
      },
      'wasi:cli/stderr@0.2.4': {
        'get-stderr': trampoline32,
      },
      'wasi:cli/stdout@0.2.4': {
        'get-stdout': trampoline30,
      },
      'wasi:clocks/monotonic-clock@0.2.4': {
        now: trampoline31,
        'subscribe-duration': trampoline12,
      },
      'wasi:clocks/wall-clock@0.2.4': {
        now: exports0['51'],
      },
      'wasi:http/outgoing-handler@0.2.4': {
        handle: exports0['50'],
      },
      'wasi:http/types@0.2.4': {
        '[constructor]fields': trampoline5,
        '[constructor]outgoing-request': trampoline6,
        '[constructor]outgoing-response': trampoline25,
        '[method]fields.append': exports0['29'],
        '[method]fields.entries': exports0['43'],
        '[method]fields.set': exports0['40'],
        '[method]future-incoming-response.get': exports0['35'],
        '[method]incoming-body.stream': exports0['37'],
        '[method]incoming-request.consume': exports0['42'],
        '[method]incoming-request.headers': trampoline22,
        '[method]incoming-request.path-with-query': exports0['41'],
        '[method]incoming-response.consume': exports0['36'],
        '[method]incoming-response.status': trampoline8,
        '[method]outgoing-body.write': exports0['38'],
        '[method]outgoing-request.body': exports0['34'],
        '[method]outgoing-request.set-authority': exports0['32'],
        '[method]outgoing-request.set-method': exports0['30'],
        '[method]outgoing-request.set-path-with-query': exports0['33'],
        '[method]outgoing-request.set-scheme': exports0['31'],
        '[method]outgoing-response.body': exports0['44'],
        '[method]outgoing-response.set-status-code': trampoline26,
        '[resource-drop]fields': trampoline15,
        '[resource-drop]future-incoming-response': trampoline11,
        '[resource-drop]future-trailers': trampoline24,
        '[resource-drop]incoming-body': trampoline18,
        '[resource-drop]incoming-request': trampoline29,
        '[resource-drop]incoming-response': trampoline10,
        '[resource-drop]outgoing-body': trampoline19,
        '[resource-drop]outgoing-request': trampoline21,
        '[resource-drop]outgoing-response': trampoline27,
        '[resource-drop]response-outparam': trampoline28,
        '[static]incoming-body.finish': trampoline23,
        '[static]outgoing-body.finish': exports0['39'],
        '[static]response-outparam.set': exports0['45'],
      },
      'wasi:io/error@0.2.4': {
        '[method]error.to-debug-string': exports0['52'],
        '[resource-drop]error': trampoline17,
      },
      'wasi:io/poll@0.2.0': {
        '[resource-drop]pollable': trampoline14,
      },
      'wasi:io/poll@0.2.4': {
        '[method]pollable.block': trampoline13,
        '[resource-drop]pollable': trampoline14,
      },
      'wasi:io/streams@0.2.0': {
        '[resource-drop]input-stream': trampoline16,
        '[resource-drop]output-stream': trampoline20,
      },
      'wasi:io/streams@0.2.4': {
        '[method]input-stream.blocking-read': exports0['48'],
        '[method]input-stream.read': exports0['47'],
        '[method]input-stream.subscribe': trampoline9,
        '[method]output-stream.blocking-write-and-flush': exports0['49'],
        '[method]output-stream.subscribe': trampoline7,
        '[method]output-stream.write': exports0['46'],
        '[resource-drop]input-stream': trampoline16,
        '[resource-drop]output-stream': trampoline20,
      },
      'wasi:random/insecure-seed@0.2.4': {
        'insecure-seed': exports0['53'],
      },
      'wasi:random/random@0.2.4': {
        'get-random-bytes': exports0['6'],
        'get-random-u64': trampoline4,
      },
      'wasi:sockets/tcp@0.2.0': {
        '[resource-drop]tcp-socket': trampoline36,
      },
      'wasi:sockets/udp@0.2.0': {
        '[resource-drop]incoming-datagram-stream': trampoline34,
        '[resource-drop]outgoing-datagram-stream': trampoline35,
        '[resource-drop]udp-socket': trampoline33,
      },
      wasi_snapshot_preview1: {
        adapter_close_badfd: exports0['28'],
        environ_get: exports0['22'],
        environ_sizes_get: exports0['23'],
        fd_close: exports0['24'],
        fd_filestat_get: exports0['14'],
        fd_filestat_set_size: exports0['9'],
        fd_prestat_dir_name: exports0['26'],
        fd_prestat_get: exports0['25'],
        fd_read: exports0['18'],
        fd_readdir: exports0['11'],
        fd_seek: exports0['8'],
        fd_tell: exports0['19'],
        fd_write: exports0['20'],
        path_create_directory: exports0['10'],
        path_filestat_get: exports0['16'],
        path_link: exports0['12'],
        path_open: exports0['21'],
        path_readlink: exports0['13'],
        path_remove_directory: exports0['17'],
        path_rename: exports0['7'],
        path_unlink_file: exports0['15'],
        proc_exit: exports0['27'],
      },
    }));
    ({ exports: exports2 } = yield instantiateCore(yield module1, {
      __main_module__: {
        _start: exports1._start,
        cabi_realloc: exports1.cabi_realloc,
      },
      env: {
        memory: exports1.memory,
      },
      'wasi:cli/environment@0.2.6': {
        'get-environment': exports0['54'],
      },
      'wasi:cli/exit@0.2.6': {
        exit: trampoline42,
      },
      'wasi:cli/stderr@0.2.6': {
        'get-stderr': trampoline32,
      },
      'wasi:cli/stdin@0.2.6': {
        'get-stdin': trampoline41,
      },
      'wasi:cli/stdout@0.2.6': {
        'get-stdout': trampoline30,
      },
      'wasi:cli/terminal-input@0.2.6': {
        '[resource-drop]terminal-input': trampoline39,
      },
      'wasi:cli/terminal-output@0.2.6': {
        '[resource-drop]terminal-output': trampoline40,
      },
      'wasi:cli/terminal-stderr@0.2.6': {
        'get-terminal-stderr': exports0['83'],
      },
      'wasi:cli/terminal-stdin@0.2.6': {
        'get-terminal-stdin': exports0['81'],
      },
      'wasi:cli/terminal-stdout@0.2.6': {
        'get-terminal-stdout': exports0['82'],
      },
      'wasi:filesystem/preopens@0.2.6': {
        'get-directories': exports0['80'],
      },
      'wasi:filesystem/types@0.2.6': {
        '[method]descriptor.append-via-stream': exports0['68'],
        '[method]descriptor.create-directory-at': exports0['59'],
        '[method]descriptor.get-type': exports0['69'],
        '[method]descriptor.link-at': exports0['61'],
        '[method]descriptor.metadata-hash': exports0['72'],
        '[method]descriptor.metadata-hash-at': exports0['73'],
        '[method]descriptor.open-at': exports0['62'],
        '[method]descriptor.read-directory': exports0['57'],
        '[method]descriptor.read-via-stream': exports0['66'],
        '[method]descriptor.readlink-at': exports0['71'],
        '[method]descriptor.remove-directory-at': exports0['63'],
        '[method]descriptor.rename-at': exports0['64'],
        '[method]descriptor.set-size': exports0['55'],
        '[method]descriptor.stat': exports0['70'],
        '[method]descriptor.stat-at': exports0['60'],
        '[method]descriptor.unlink-file-at': exports0['65'],
        '[method]descriptor.write-via-stream': exports0['67'],
        '[method]directory-entry-stream.read-directory-entry': exports0['58'],
        '[resource-drop]descriptor': trampoline38,
        '[resource-drop]directory-entry-stream': trampoline37,
        'filesystem-error-code': exports0['56'],
      },
      'wasi:io/error@0.2.6': {
        '[resource-drop]error': trampoline17,
      },
      'wasi:io/streams@0.2.6': {
        '[method]input-stream.blocking-read': exports0['74'],
        '[method]input-stream.read': exports0['75'],
        '[method]output-stream.blocking-flush': exports0['78'],
        '[method]output-stream.blocking-write-and-flush': exports0['79'],
        '[method]output-stream.check-write': exports0['76'],
        '[method]output-stream.write': exports0['77'],
        '[resource-drop]input-stream': trampoline16,
        '[resource-drop]output-stream': trampoline20,
      },
    }));
    memory0 = exports1.memory;
    realloc0 = exports1.cabi_realloc;
    realloc1 = exports2.cabi_import_realloc;
    ({ exports: exports3 } = yield instantiateCore(yield module3, {
      '': {
        $imports: exports0.$imports,
        '0': trampoline43,
        '1': trampoline44,
        '10': exports2.path_create_directory,
        '11': exports2.fd_readdir,
        '12': exports2.path_link,
        '13': exports2.path_readlink,
        '14': exports2.fd_filestat_get,
        '15': exports2.path_unlink_file,
        '16': exports2.path_filestat_get,
        '17': exports2.path_remove_directory,
        '18': exports2.fd_read,
        '19': exports2.fd_tell,
        '2': trampoline45,
        '20': exports2.fd_write,
        '21': exports2.path_open,
        '22': exports2.environ_get,
        '23': exports2.environ_sizes_get,
        '24': exports2.fd_close,
        '25': exports2.fd_prestat_get,
        '26': exports2.fd_prestat_dir_name,
        '27': exports2.proc_exit,
        '28': exports2.adapter_close_badfd,
        '29': trampoline50,
        '3': trampoline46,
        '30': trampoline51,
        '31': trampoline52,
        '32': trampoline53,
        '33': trampoline54,
        '34': trampoline55,
        '35': trampoline56,
        '36': trampoline57,
        '37': trampoline58,
        '38': trampoline59,
        '39': trampoline60,
        '4': trampoline47,
        '40': trampoline61,
        '41': trampoline62,
        '42': trampoline63,
        '43': trampoline64,
        '44': trampoline65,
        '45': trampoline66,
        '46': trampoline67,
        '47': trampoline68,
        '48': trampoline69,
        '49': trampoline70,
        '5': trampoline48,
        '50': trampoline71,
        '51': trampoline72,
        '52': trampoline73,
        '53': trampoline74,
        '54': trampoline75,
        '55': trampoline76,
        '56': trampoline77,
        '57': trampoline78,
        '58': trampoline79,
        '59': trampoline80,
        '6': trampoline49,
        '60': trampoline81,
        '61': trampoline82,
        '62': trampoline83,
        '63': trampoline84,
        '64': trampoline85,
        '65': trampoline86,
        '66': trampoline87,
        '67': trampoline88,
        '68': trampoline89,
        '69': trampoline90,
        '7': exports2.path_rename,
        '70': trampoline91,
        '71': trampoline92,
        '72': trampoline93,
        '73': trampoline94,
        '74': trampoline95,
        '75': trampoline96,
        '76': trampoline97,
        '77': trampoline67,
        '78': trampoline98,
        '79': trampoline70,
        '8': exports2.fd_seek,
        '80': trampoline99,
        '81': trampoline100,
        '82': trampoline101,
        '83': trampoline102,
        '9': exports2.fd_filestat_set_size,
      },
    }));
    postReturn0 = exports1['cabi_post_shell:unix/command@0.1.0#list-commands'];
    _initialized = true;
    incomingHandler024Handle = exports1['wasi:http/incoming-handler@0.2.4#handle'];
    command010Run = exports1['shell:unix/command@0.1.0#run'];
    command010ListCommands = exports1['shell:unix/command@0.1.0#list-commands'];
    run026Run = exports2['wasi:cli/run@0.2.6#run'];
  })();
  let promise, resolve, reject;
  function runNext (value) {
    try {
      let done;
      do {
        ({ value, done } = gen.next(value));
      } while (!(value instanceof Promise) && !done);
      if (done) {
        if (resolve) resolve(value);
        else return value;
      }
      if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
      value.then(runNext, reject);
    }
    catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
  const maybeSyncReturn = runNext(null);
  return promise || maybeSyncReturn;
})();
const command010 = {
  listCommands: listCommands,
  run: run,
  
};
const run026 = {
  run: run$1,
  
};
const incomingHandler024 = {
  handle: handle$1,
  
};

export { command010 as command, incomingHandler024 as incomingHandler, run026 as run, command010 as 'shell:unix/command@0.1.0', run026 as 'wasi:cli/run@0.2.6', incomingHandler024 as 'wasi:http/incoming-handler@0.2.4',  }