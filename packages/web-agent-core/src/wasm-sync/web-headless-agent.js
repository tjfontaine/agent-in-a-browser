import { monotonicClock } from '@tjfontaine/wasi-shims/clocks-impl.js';
import { error } from '@tjfontaine/wasi-shims/error.js';
import { environment, exit as exit$1, stderr } from '@tjfontaine/wasi-shims/ghostty-cli-shim.js';
import { Pollable } from '@tjfontaine/wasi-shims/poll-impl.js';
import { insecureSeed as insecureSeed$1 } from '@tjfontaine/wasi-shims/random.js';
import { InputStream, OutputStream } from '@tjfontaine/wasi-shims/streams.js';
import { Fields, FutureIncomingResponse, IncomingBody, IncomingResponse, OutgoingBody, OutgoingRequest, RequestOptions, outgoingHandler } from '@tjfontaine/wasi-shims/wasi-http-impl.js';
const { subscribeDuration } = monotonicClock;
const { Error: Error$1 } = error;
const { getEnvironment } = environment;
const { exit } = exit$1;
const { getStderr } = stderr;
const { insecureSeed } = insecureSeed$1;
const { handle } = outgoingHandler;

let dv = new DataView(new ArrayBuffer());
const dataView = mem => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);

const toUint64 = val => BigInt.asUintN(64, BigInt(val));

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
const handleTable4 = [T_FLAG, 0];
const captureTable4= new Map();
let captureCnt4 = 0;
handleTables[4] = handleTable4;

function trampoline0() {
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

function trampoline1() {
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]request-options"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[constructor]request-options');
  const ret = new RequestOptions();
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]request-options"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof RequestOptions)) {
    throw new TypeError('Resource error: Not a valid "RequestOptions" resource.');
  }
  var handle0 = ret[symbolRscHandle];
  if (!handle0) {
    const rep = ret[symbolRscRep] || ++captureCnt5;
    captureTable5.set(rep, ret);
    handle0 = rscTableCreateOwn(handleTable5, rep);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]request-options"][Instruction::Return]', {
    funcName: '[constructor]request-options',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle0;
}

const handleTable6 = [T_FLAG, 0];
const captureTable6= new Map();
let captureCnt6 = 0;
handleTables[6] = handleTable6;

function trampoline2(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable6.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(IncomingResponse.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.headers"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]incoming-response.headers');
  const ret = rsc0.headers();
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.headers"] [Instruction::CallInterface] (sync, @ post-call)');
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
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.headers"][Instruction::Return]', {
    funcName: '[method]incoming-response.headers',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle3;
}

const handleTable0 = [T_FLAG, 0];
const captureTable0= new Map();
let captureCnt0 = 0;
handleTables[0] = handleTable0;

function trampoline3(arg0) {
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


function trampoline4(arg0) {
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

const handleTable9 = [T_FLAG, 0];
const captureTable9= new Map();
let captureCnt9 = 0;
handleTables[9] = handleTable9;

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
    const rep = ret[symbolRscRep] || ++captureCnt9;
    captureTable9.set(rep, ret);
    handle3 = rscTableCreateOwn(handleTable9, rep);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]outgoing-request"][Instruction::Return]', {
    funcName: '[constructor]outgoing-request',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return handle3;
}


function trampoline7(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable6.get(rep2);
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

const handleTable10 = [T_FLAG, 0];
const captureTable10= new Map();
let captureCnt10 = 0;
handleTables[10] = handleTable10;

function trampoline8(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable10[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable10.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(FutureIncomingResponse.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]future-incoming-response.subscribe"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]future-incoming-response.subscribe');
  const ret = rsc0.subscribe();
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]future-incoming-response.subscribe"] [Instruction::CallInterface] (sync, @ post-call)');
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
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]future-incoming-response.subscribe"][Instruction::Return]', {
    funcName: '[method]future-incoming-response.subscribe',
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

function trampoline19() {
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

function trampoline20(arg0) {
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

function trampoline21(arg0, arg1) {
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

const handleTable7 = [T_FLAG, 0];
const captureTable7= new Map();
let captureCnt7 = 0;
handleTables[7] = handleTable7;
const handleTable2 = [T_FLAG, 0];
const captureTable2= new Map();
let captureCnt2 = 0;
handleTables[2] = handleTable2;

function trampoline22(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable7.get(rep2);
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

const handleTable8 = [T_FLAG, 0];
const captureTable8= new Map();
let captureCnt8 = 0;
handleTables[8] = handleTable8;

function trampoline23(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
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


function trampoline24(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingBody.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  else {
    captureTable8.delete(rep2);
  }
  rscTableRemove(handleTable8, handle1);
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


function trampoline25(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
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


function trampoline26(arg0, arg1, arg2, arg3, arg4) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
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


function trampoline27(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
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


function trampoline28(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
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


function trampoline29(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
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
        const rep = e[symbolRscRep] || ++captureCnt8;
        captureTable8.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable8, rep);
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


function trampoline30(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable6.get(rep2);
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
        const rep = e[symbolRscRep] || ++captureCnt7;
        captureTable7.set(rep, e);
        handle3 = rscTableCreateOwn(handleTable7, rep);
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


function trampoline31(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable10[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable10.get(rep2);
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
              const rep = e[symbolRscRep] || ++captureCnt6;
              captureTable6.set(rep, e);
              handle3 = rscTableCreateOwn(handleTable6, rep);
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


function trampoline32(arg0, arg1, arg2, arg3, arg4, arg5) {
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

const handleTable1 = [T_FLAG, 0];
const captureTable1= new Map();
let captureCnt1 = 0;
handleTables[1] = handleTable1;

function trampoline33(arg0, arg1, arg2) {
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


function trampoline34(arg0, arg1, arg2, arg3) {
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


function trampoline35(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingRequest.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  else {
    captureTable9.delete(rep2);
  }
  rscTableRemove(handleTable9, handle1);
  let variant6;
  if (arg1) {
    var handle4 = arg2;
    var rep5 = handleTable5[(handle4 << 1) + 1] & ~T_FLAG;
    var rsc3 = captureTable5.get(rep5);
    if (!rsc3) {
      rsc3 = Object.create(RequestOptions.prototype);
      Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
      Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
    }
    else {
      captureTable5.delete(rep5);
    }
    rscTableRemove(handleTable5, handle4);
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
        const rep = e[symbolRscRep] || ++captureCnt10;
        captureTable10.set(rep, e);
        handle7 = rscTableCreateOwn(handleTable10, rep);
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


function trampoline36(arg0, arg1) {
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


function trampoline37(arg0) {
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


function trampoline38(arg0) {
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

let exports3;
let postReturn0;
let postReturn1;
let postReturn2;
function trampoline5(handle) {
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
function trampoline9(handle) {
  const handleEntry = rscTableRemove(handleTable5, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable5.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable5.delete(handleEntry.rep);
    } else if (RequestOptions[symbolCabiDispose]) {
      RequestOptions[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline10(handle) {
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
function trampoline11(handle) {
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
function trampoline12(handle) {
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
function trampoline13(handle) {
  const handleEntry = rscTableRemove(handleTable7, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable7.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable7.delete(handleEntry.rep);
    } else if (IncomingBody[symbolCabiDispose]) {
      IncomingBody[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline14(handle) {
  const handleEntry = rscTableRemove(handleTable8, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable8.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable8.delete(handleEntry.rep);
    } else if (OutgoingBody[symbolCabiDispose]) {
      OutgoingBody[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline15(handle) {
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
function trampoline16(handle) {
  const handleEntry = rscTableRemove(handleTable9, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable9.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable9.delete(handleEntry.rep);
    } else if (OutgoingRequest[symbolCabiDispose]) {
      OutgoingRequest[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline17(handle) {
  const handleEntry = rscTableRemove(handleTable6, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable6.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable6.delete(handleEntry.rep);
    } else if (IncomingResponse[symbolCabiDispose]) {
      IncomingResponse[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline18(handle) {
  const handleEntry = rscTableRemove(handleTable10, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable10.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable10.delete(handleEntry.rep);
    } else if (FutureIncomingResponse[symbolCabiDispose]) {
      FutureIncomingResponse[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let exports1Create;

function create(arg0) {
  if (!_initialized) throwUninitialized();
  var ptr0 = realloc0(0, 0, 4, 80);
  var {provider: v1_0, model: v1_1, apiKey: v1_2, baseUrl: v1_3, preamble: v1_4, preambleOverride: v1_5, mcpServers: v1_6, maxTurns: v1_7 } = arg0;
  var ptr2 = utf8Encode(v1_0, realloc0, memory0);
  var len2 = utf8EncodedLen;
  dataView(memory0).setUint32(ptr0 + 4, len2, true);
  dataView(memory0).setUint32(ptr0 + 0, ptr2, true);
  var ptr3 = utf8Encode(v1_1, realloc0, memory0);
  var len3 = utf8EncodedLen;
  dataView(memory0).setUint32(ptr0 + 12, len3, true);
  dataView(memory0).setUint32(ptr0 + 8, ptr3, true);
  var ptr4 = utf8Encode(v1_2, realloc0, memory0);
  var len4 = utf8EncodedLen;
  dataView(memory0).setUint32(ptr0 + 20, len4, true);
  dataView(memory0).setUint32(ptr0 + 16, ptr4, true);
  var variant6 = v1_3;
  if (variant6 === null || variant6=== undefined) {
    dataView(memory0).setInt8(ptr0 + 24, 0, true);
  } else {
    const e = variant6;
    dataView(memory0).setInt8(ptr0 + 24, 1, true);
    var ptr5 = utf8Encode(e, realloc0, memory0);
    var len5 = utf8EncodedLen;
    dataView(memory0).setUint32(ptr0 + 32, len5, true);
    dataView(memory0).setUint32(ptr0 + 28, ptr5, true);
  }
  var variant8 = v1_4;
  if (variant8 === null || variant8=== undefined) {
    dataView(memory0).setInt8(ptr0 + 36, 0, true);
  } else {
    const e = variant8;
    dataView(memory0).setInt8(ptr0 + 36, 1, true);
    var ptr7 = utf8Encode(e, realloc0, memory0);
    var len7 = utf8EncodedLen;
    dataView(memory0).setUint32(ptr0 + 44, len7, true);
    dataView(memory0).setUint32(ptr0 + 40, ptr7, true);
  }
  var variant10 = v1_5;
  if (variant10 === null || variant10=== undefined) {
    dataView(memory0).setInt8(ptr0 + 48, 0, true);
  } else {
    const e = variant10;
    dataView(memory0).setInt8(ptr0 + 48, 1, true);
    var ptr9 = utf8Encode(e, realloc0, memory0);
    var len9 = utf8EncodedLen;
    dataView(memory0).setUint32(ptr0 + 56, len9, true);
    dataView(memory0).setUint32(ptr0 + 52, ptr9, true);
  }
  var variant16 = v1_6;
  if (variant16 === null || variant16=== undefined) {
    dataView(memory0).setInt8(ptr0 + 60, 0, true);
  } else {
    const e = variant16;
    dataView(memory0).setInt8(ptr0 + 60, 1, true);
    var vec15 = e;
    var len15 = vec15.length;
    var result15 = realloc0(0, 0, 4, len15 * 20);
    for (let i = 0; i < vec15.length; i++) {
      const e = vec15[i];
      const base = result15 + i * 20;var {url: v11_0, name: v11_1 } = e;
      var ptr12 = utf8Encode(v11_0, realloc0, memory0);
      var len12 = utf8EncodedLen;
      dataView(memory0).setUint32(base + 4, len12, true);
      dataView(memory0).setUint32(base + 0, ptr12, true);
      var variant14 = v11_1;
      if (variant14 === null || variant14=== undefined) {
        dataView(memory0).setInt8(base + 8, 0, true);
      } else {
        const e = variant14;
        dataView(memory0).setInt8(base + 8, 1, true);
        var ptr13 = utf8Encode(e, realloc0, memory0);
        var len13 = utf8EncodedLen;
        dataView(memory0).setUint32(base + 16, len13, true);
        dataView(memory0).setUint32(base + 12, ptr13, true);
      }
    }
    dataView(memory0).setUint32(ptr0 + 68, len15, true);
    dataView(memory0).setUint32(ptr0 + 64, result15, true);
  }
  var variant17 = v1_7;
  if (variant17 === null || variant17=== undefined) {
    dataView(memory0).setInt8(ptr0 + 72, 0, true);
  } else {
    const e = variant17;
    dataView(memory0).setInt8(ptr0 + 72, 1, true);
    dataView(memory0).setInt32(ptr0 + 76, toUint32(e), true);
  }
  _debugLog('[iface="create", function="create"][Instruction::CallWasm] enter', {
    funcName: 'create',
    paramCount: 1,
    async: false,
    postReturn: true,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1Create');
  const ret = exports1Create(ptr0);
  endCurrentTask(0);
  let variant19;
  if (dataView(memory0).getUint8(ret + 0, true)) {
    var ptr18 = dataView(memory0).getUint32(ret + 4, true);
    var len18 = dataView(memory0).getUint32(ret + 8, true);
    var result18 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr18, len18));
    variant19= {
      tag: 'err',
      val: result18
    };
  } else {
    variant19= {
      tag: 'ok',
      val: dataView(memory0).getInt32(ret + 4, true) >>> 0
    };
  }
  _debugLog('[iface="create", function="create"][Instruction::Return]', {
    funcName: 'create',
    paramCount: 1,
    async: false,
    postReturn: true
  });
  const retCopy = variant19;
  
  let cstate = getOrCreateAsyncState(0);
  cstate.mayLeave = false;
  postReturn0(ret);
  cstate.mayLeave = true;
  
  
  
  if (typeof retCopy === 'object' && retCopy.tag === 'err') {
    throw new ComponentError(retCopy.val);
  }
  return retCopy.val;
  
}
let exports1Destroy;

function destroy(arg0) {
  if (!_initialized) throwUninitialized();
  _debugLog('[iface="destroy", function="destroy"][Instruction::CallWasm] enter', {
    funcName: 'destroy',
    paramCount: 1,
    async: false,
    postReturn: false,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1Destroy');
  exports1Destroy(toUint32(arg0));
  endCurrentTask(0);
  _debugLog('[iface="destroy", function="destroy"][Instruction::Return]', {
    funcName: 'destroy',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}
let exports1Send;

function send(arg0, arg1) {
  if (!_initialized) throwUninitialized();
  var ptr0 = utf8Encode(arg1, realloc0, memory0);
  var len0 = utf8EncodedLen;
  _debugLog('[iface="send", function="send"][Instruction::CallWasm] enter', {
    funcName: 'send',
    paramCount: 3,
    async: false,
    postReturn: true,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1Send');
  const ret = exports1Send(toUint32(arg0), ptr0, len0);
  endCurrentTask(0);
  let variant2;
  if (dataView(memory0).getUint8(ret + 0, true)) {
    var ptr1 = dataView(memory0).getUint32(ret + 4, true);
    var len1 = dataView(memory0).getUint32(ret + 8, true);
    var result1 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr1, len1));
    variant2= {
      tag: 'err',
      val: result1
    };
  } else {
    variant2= {
      tag: 'ok',
      val: undefined
    };
  }
  _debugLog('[iface="send", function="send"][Instruction::Return]', {
    funcName: 'send',
    paramCount: 1,
    async: false,
    postReturn: true
  });
  const retCopy = variant2;
  
  let cstate = getOrCreateAsyncState(0);
  cstate.mayLeave = false;
  postReturn0(ret);
  cstate.mayLeave = true;
  
  
  
  if (typeof retCopy === 'object' && retCopy.tag === 'err') {
    throw new ComponentError(retCopy.val);
  }
  return retCopy.val;
  
}
let exports1Poll;

function poll(arg0) {
  if (!_initialized) throwUninitialized();
  _debugLog('[iface="poll", function="poll"][Instruction::CallWasm] enter', {
    funcName: 'poll',
    paramCount: 1,
    async: false,
    postReturn: true,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1Poll');
  const ret = exports1Poll(toUint32(arg0));
  endCurrentTask(0);
  let variant20;
  if (dataView(memory0).getUint8(ret + 0, true)) {
    let variant19;
    switch (dataView(memory0).getUint8(ret + 4, true)) {
      case 0: {
        variant19= {
          tag: 'stream-start',
        };
        break;
      }
      case 1: {
        var ptr0 = dataView(memory0).getUint32(ret + 8, true);
        var len0 = dataView(memory0).getUint32(ret + 12, true);
        var result0 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr0, len0));
        variant19= {
          tag: 'stream-chunk',
          val: result0
        };
        break;
      }
      case 2: {
        var ptr1 = dataView(memory0).getUint32(ret + 8, true);
        var len1 = dataView(memory0).getUint32(ret + 12, true);
        var result1 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr1, len1));
        variant19= {
          tag: 'stream-complete',
          val: result1
        };
        break;
      }
      case 3: {
        var ptr2 = dataView(memory0).getUint32(ret + 8, true);
        var len2 = dataView(memory0).getUint32(ret + 12, true);
        var result2 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr2, len2));
        variant19= {
          tag: 'stream-error',
          val: result2
        };
        break;
      }
      case 4: {
        var ptr3 = dataView(memory0).getUint32(ret + 8, true);
        var len3 = dataView(memory0).getUint32(ret + 12, true);
        var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
        variant19= {
          tag: 'tool-call',
          val: result3
        };
        break;
      }
      case 5: {
        var ptr4 = dataView(memory0).getUint32(ret + 8, true);
        var len4 = dataView(memory0).getUint32(ret + 12, true);
        var result4 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr4, len4));
        var ptr5 = dataView(memory0).getUint32(ret + 16, true);
        var len5 = dataView(memory0).getUint32(ret + 20, true);
        var result5 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr5, len5));
        var bool6 = dataView(memory0).getUint8(ret + 24, true);
        variant19= {
          tag: 'tool-result',
          val: {
            name: result4,
            output: result5,
            isError: !!bool6,
          }
        };
        break;
      }
      case 6: {
        var ptr7 = dataView(memory0).getUint32(ret + 8, true);
        var len7 = dataView(memory0).getUint32(ret + 12, true);
        var result7 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr7, len7));
        variant19= {
          tag: 'plan-generated',
          val: result7
        };
        break;
      }
      case 7: {
        var ptr8 = dataView(memory0).getUint32(ret + 8, true);
        var len8 = dataView(memory0).getUint32(ret + 12, true);
        var result8 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr8, len8));
        var ptr9 = dataView(memory0).getUint32(ret + 16, true);
        var len9 = dataView(memory0).getUint32(ret + 20, true);
        var result9 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr9, len9));
        var ptr10 = dataView(memory0).getUint32(ret + 24, true);
        var len10 = dataView(memory0).getUint32(ret + 28, true);
        var result10 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr10, len10));
        variant19= {
          tag: 'task-start',
          val: {
            id: result8,
            name: result9,
            description: result10,
          }
        };
        break;
      }
      case 8: {
        var ptr11 = dataView(memory0).getUint32(ret + 8, true);
        var len11 = dataView(memory0).getUint32(ret + 12, true);
        var result11 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr11, len11));
        var ptr12 = dataView(memory0).getUint32(ret + 16, true);
        var len12 = dataView(memory0).getUint32(ret + 20, true);
        var result12 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr12, len12));
        let variant13;
        if (dataView(memory0).getUint8(ret + 24, true)) {
          variant13 = dataView(memory0).getInt32(ret + 28, true) >>> 0;
        } else {
          variant13 = undefined;
        }
        variant19= {
          tag: 'task-update',
          val: {
            id: result11,
            status: result12,
            progress: variant13,
          }
        };
        break;
      }
      case 9: {
        var ptr14 = dataView(memory0).getUint32(ret + 8, true);
        var len14 = dataView(memory0).getUint32(ret + 12, true);
        var result14 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr14, len14));
        var bool15 = dataView(memory0).getUint8(ret + 16, true);
        let variant17;
        if (dataView(memory0).getUint8(ret + 20, true)) {
          var ptr16 = dataView(memory0).getUint32(ret + 24, true);
          var len16 = dataView(memory0).getUint32(ret + 28, true);
          var result16 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr16, len16));
          variant17 = result16;
        } else {
          variant17 = undefined;
        }
        variant19= {
          tag: 'task-complete',
          val: {
            id: result14,
            success: !!bool15,
            output: variant17,
          }
        };
        break;
      }
      case 10: {
        var ptr18 = dataView(memory0).getUint32(ret + 8, true);
        var len18 = dataView(memory0).getUint32(ret + 12, true);
        var result18 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr18, len18));
        variant19= {
          tag: 'model-loading',
          val: {
            text: result18,
            progress: dataView(memory0).getFloat32(ret + 16, true),
          }
        };
        break;
      }
      case 11: {
        variant19= {
          tag: 'ready',
        };
        break;
      }
    }
    variant20 = variant19;
  } else {
    variant20 = undefined;
  }
  _debugLog('[iface="poll", function="poll"][Instruction::Return]', {
    funcName: 'poll',
    paramCount: 1,
    async: false,
    postReturn: true
  });
  const retCopy = variant20;
  
  let cstate = getOrCreateAsyncState(0);
  cstate.mayLeave = false;
  postReturn1(ret);
  cstate.mayLeave = true;
  return retCopy;
  
}
let exports1Cancel;

function cancel(arg0) {
  if (!_initialized) throwUninitialized();
  _debugLog('[iface="cancel", function="cancel"][Instruction::CallWasm] enter', {
    funcName: 'cancel',
    paramCount: 1,
    async: false,
    postReturn: false,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1Cancel');
  exports1Cancel(toUint32(arg0));
  endCurrentTask(0);
  _debugLog('[iface="cancel", function="cancel"][Instruction::Return]', {
    funcName: 'cancel',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}
let exports1Plan;

function plan(arg0, arg1) {
  if (!_initialized) throwUninitialized();
  var ptr0 = utf8Encode(arg1, realloc0, memory0);
  var len0 = utf8EncodedLen;
  _debugLog('[iface="plan", function="plan"][Instruction::CallWasm] enter', {
    funcName: 'plan',
    paramCount: 3,
    async: false,
    postReturn: true,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1Plan');
  const ret = exports1Plan(toUint32(arg0), ptr0, len0);
  endCurrentTask(0);
  let variant2;
  if (dataView(memory0).getUint8(ret + 0, true)) {
    var ptr1 = dataView(memory0).getUint32(ret + 4, true);
    var len1 = dataView(memory0).getUint32(ret + 8, true);
    var result1 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr1, len1));
    variant2= {
      tag: 'err',
      val: result1
    };
  } else {
    variant2= {
      tag: 'ok',
      val: undefined
    };
  }
  _debugLog('[iface="plan", function="plan"][Instruction::Return]', {
    funcName: 'plan',
    paramCount: 1,
    async: false,
    postReturn: true
  });
  const retCopy = variant2;
  
  let cstate = getOrCreateAsyncState(0);
  cstate.mayLeave = false;
  postReturn0(ret);
  cstate.mayLeave = true;
  
  
  
  if (typeof retCopy === 'object' && retCopy.tag === 'err') {
    throw new ComponentError(retCopy.val);
  }
  return retCopy.val;
  
}
let exports1Execute;

function execute(arg0) {
  if (!_initialized) throwUninitialized();
  _debugLog('[iface="execute", function="execute"][Instruction::CallWasm] enter', {
    funcName: 'execute',
    paramCount: 1,
    async: false,
    postReturn: true,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1Execute');
  const ret = exports1Execute(toUint32(arg0));
  endCurrentTask(0);
  let variant1;
  if (dataView(memory0).getUint8(ret + 0, true)) {
    var ptr0 = dataView(memory0).getUint32(ret + 4, true);
    var len0 = dataView(memory0).getUint32(ret + 8, true);
    var result0 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr0, len0));
    variant1= {
      tag: 'err',
      val: result0
    };
  } else {
    variant1= {
      tag: 'ok',
      val: undefined
    };
  }
  _debugLog('[iface="execute", function="execute"][Instruction::Return]', {
    funcName: 'execute',
    paramCount: 1,
    async: false,
    postReturn: true
  });
  const retCopy = variant1;
  
  let cstate = getOrCreateAsyncState(0);
  cstate.mayLeave = false;
  postReturn0(ret);
  cstate.mayLeave = true;
  
  
  
  if (typeof retCopy === 'object' && retCopy.tag === 'err') {
    throw new ComponentError(retCopy.val);
  }
  return retCopy.val;
  
}
let exports1GetHistory;

function getHistory(arg0) {
  if (!_initialized) throwUninitialized();
  _debugLog('[iface="get-history", function="get-history"][Instruction::CallWasm] enter', {
    funcName: 'get-history',
    paramCount: 1,
    async: false,
    postReturn: true,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1GetHistory');
  const ret = exports1GetHistory(toUint32(arg0));
  endCurrentTask(0);
  var len2 = dataView(memory0).getUint32(ret + 4, true);
  var base2 = dataView(memory0).getUint32(ret + 0, true);
  var result2 = [];
  for (let i = 0; i < len2; i++) {
    const base = base2 + i * 12;
    let enum0;
    switch (dataView(memory0).getUint8(base + 0, true)) {
      case 0: {
        enum0 = 'user';
        break;
      }
      case 1: {
        enum0 = 'assistant';
        break;
      }
    }
    var ptr1 = dataView(memory0).getUint32(base + 4, true);
    var len1 = dataView(memory0).getUint32(base + 8, true);
    var result1 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr1, len1));
    result2.push({
      role: enum0,
      content: result1,
    });
  }
  _debugLog('[iface="get-history", function="get-history"][Instruction::Return]', {
    funcName: 'get-history',
    paramCount: 1,
    async: false,
    postReturn: true
  });
  const retCopy = result2;
  
  let cstate = getOrCreateAsyncState(0);
  cstate.mayLeave = false;
  postReturn2(ret);
  cstate.mayLeave = true;
  return retCopy;
  
}
let exports1ClearHistory;

function clearHistory(arg0) {
  if (!_initialized) throwUninitialized();
  _debugLog('[iface="clear-history", function="clear-history"][Instruction::CallWasm] enter', {
    funcName: 'clear-history',
    paramCount: 1,
    async: false,
    postReturn: false,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1ClearHistory');
  exports1ClearHistory(toUint32(arg0));
  endCurrentTask(0);
  _debugLog('[iface="clear-history", function="clear-history"][Instruction::Return]', {
    funcName: 'clear-history',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

let _initialized = false;
export const $init = (() => {
  let gen = (function* _initGenerator () {
    const module0 = fetchCompile(new URL('./web-headless-agent.core.wasm', import.meta.url));
    const module1 = base64Compile('AGFzbQEAAAABLQhgAX8AYAJ/fwBgBH9/f38AYAR/f39/AX9gAAF/YAJ/fwF/YAN/f38Bf2AAAALAAggDZW52Bm1lbW9yeQIAABp3YXNpOmNsaS9lbnZpcm9ubWVudEAwLjIuNg9nZXQtZW52aXJvbm1lbnQAABV3YXNpOmlvL3N0cmVhbXNAMC4yLjYcW3Jlc291cmNlLWRyb3Bdb3V0cHV0LXN0cmVhbQAAE3dhc2k6aW8vZXJyb3JAMC4yLjYUW3Jlc291cmNlLWRyb3BdZXJyb3IAAA9fX21haW5fbW9kdWxlX18MY2FiaV9yZWFsbG9jAAMVd2FzaTpjbGkvc3RkZXJyQDAuMi42CmdldC1zdGRlcnIABBV3YXNpOmlvL3N0cmVhbXNAMC4yLjYuW21ldGhvZF1vdXRwdXQtc3RyZWFtLmJsb2NraW5nLXdyaXRlLWFuZC1mbHVzaAACE3dhc2k6Y2xpL2V4aXRAMC4yLjYEZXhpdAAAAxUUBAADBgABAAUFAgAABAAABAAEAAcGEAN/AUEAC38BQQALfwFBAAsHRQQRZW52aXJvbl9zaXplc19nZXQADwlwcm9jX2V4aXQAEQtlbnZpcm9uX2dldAAOE2NhYmlfaW1wb3J0X3JlYWxsb2MACQr8ExQVAQF/AkAQFiIADQAQEyIAEBcLIAALYgEBfyMAQTBrIgEkACABQSA6AC8gAUL0ysmDwq2at+UANwAnIAFCoMLRg5KM2bDwADcAHyABQu7AmIuWjduy5AA3ABcgAULh5s2rpo7dtO8ANwAPIAFBD2pBIRAMIAAQFQALsAQCAn8BfhAaIwBBMGsiBCQAAkACQAJAAkACQAJAAkACQAJAAkAQByIFKAIAQfXOoYsCRw0AIAUoAvz/A0H1zqGLAkcNASAFKQIEIQYgBUEENgIEIARBEGogBUEUaigCADYCACAEQQhqIAVBDGopAgA3AwAgBCAGNwMAIABFDQIgASADTQ0DIAJBAUYNCUGDAxAIAAtB8xUQCAALQfQVEAgACyAEKAIADgUFAwIBBAULQYIDEAgACyAEQQxqIQACQCACQQFGDQAgACACIAMQCiEADAULIAQgBCgCBCICQQFqNgIEAkAgAiAEKAIIRg0AIAQgBCkCDDcCGCAEQRhqQQEgAxAKIQAMBQsgAEEBIAMQCiEADAQLAkAgAkEBRg0AIARBDGogAiADEAohAAwECyAEQQRyQQEgA0EBahAKIQAMAwsCQCACQQFGDQAgBEEIaiACIAMQCiEADAMLIAQgBCgCBCADajYCBCAEIAQpAwg3AhggBEEYakEBIAMQCiEADAILQawDEAsgBEG6wAA7ABggBEEYakECEAwgBELm0p2rp66Zsgo3ACggBELh6L2Th+TYt+4ANwAgIARC7t6BicaN27fjADcAGCAEQRhqQRgQDCAEQQo6ABggBEEYakEBEAwACyAEQQRyIAIgAxAKIQAgBEEENgIACyAFQQRqIgUgBCkDADcCACAFQRBqIARBEGooAgA2AgAgBUEIaiAEQQhqKQMANwIAIARBMGokACAAC5kDAQN/IwBBIGsiAyQAAkACQAJAIAFpQQFHDQAgACgCBCIEIAEgACgCACIFakF/akEAIAFrcSAFayIBSQ0BIAQgAWsiBCACTw0CQcIDEAsgA0G6wAA7AAMgA0EDakECEAwgA0EKOgAfIANB4eSdqwY2ABsgA0Lp5oGh9+2bkOwANwATIANC79yBmZfN3rIgNwALIANC4dix+7asmLrpADcAAyADQQNqQR0QDCADQQo6AAMgA0EDakEBEAwAC0HMAxALIANBusAAOwADIANBA2pBAhAMIANB9BQ7ABMgA0Lh2KW75q3bsu4ANwALIANC6dzZi8atmrIgNwADIANBA2pBEhAMIANBCjoAAyADQQNqQQEQDAALQdADEAsgA0G6wAA7AAMgA0EDakECEAwgA0EKOgAVIANB9MoBOwATIANC78CE48bt27HhADcACyADQubCpePWjJmQ9AA3AAMgA0EDakETEAwgA0EKOgADIANBA2pBARAMAAsgACAEIAJrNgIEIAAgBSABaiIBIAJqNgIAIANBIGokACABC3EBAX8jAEEwayIBJAAgAUEgOgAvIAFB7NK5qwY2ACsgAULhyIWDx66ZuSA3ACMgAUL16JWjhqSYuiA3ABsgAULi2JWD0ozesuMANwATIAFC9dzJq5bsmLThADcACyABQQtqQSUQDCAAEBQgAUEwaiQAC2EBAX8jAEEQayICJAAgAhAENgIMIAJBBGogAkEMaiAAIAEQEAJAIAIoAgQiAUECRg0AIAENACACKAIIIgFBf0YNACABEAILAkAgAigCDCIBQX9GDQAgARABCyACQRBqJAALIgEBfyMAQRBrIgEkACAAEAsgAUEKOgAPIAFBD2pBARAMAAvvAgEGfxAaIwBBIGsiAiQAAkACQAJAEAciAygCAEH1zqGLAkcNACADKAL8/wNB9c6hiwJHDQEgA0GYzQM2AhQgA0F/NgIMIAMgATYCCCADIANBsDBqNgIQIAMoAgQhASADQQI2AgQgAUEERw0CIAJCADcCACACEAAgAigCBCEEIAIoAgAhASADQQQ2AgQCQCAERQ0AA0AgAUEMaigCACEDIAFBCGooAgAhBSABQQRqKAIAIQYgACABKAIAIgc2AgAgByAGakE9OgAAIAUgA2pBADoAACABQRBqIQEgAEEEaiEAIARBf2oiBA0ACwsgAkEgaiQAQQAPC0HzFRAIAAtB9BUQCAALQYAXEAsgAkG6wAA7AAAgAkECEAwgAkEKOgAcIAJBoOaVowc2ABggAkKgwrGT16yYsvkANwAQIAJC7Ni9m5aM3bfyADcACCACQunawfumjp2Q4QA3AAAgAkEdEAwgAkEKOgAAIAJBARAMAAvRAgEEfxAaIwBBIGsiAiQAAkACQAJAAkACQAJAAkAQGEF+ag4DAQABAAtBACEDIABBADYCAAwBCxAHIgMoAgBB9c6hiwJHDQEgAygC/P8DQfXOoYsCRw0CIANBmM0DNgIQIAMgA0GwMGo2AgwgAygCBCEEIANCATcCBCAEQQRHDQMgAkIANwIAIAIQACACKAIEIQQgAygCBCEFIANBBDYCBCAFQQFHDQQgAygCCCEDIAAgBDYCACADIARBAXRqIQMLIAEgAzYCACACQSBqJABBAA8LQfMVEAgAC0H0FRAIAAtBgBcQCyACQbrAADsAACACQQIQDCACQQo6ABwgAkGg5pWjBzYAGCACQqDCsZPXrJiy+QA3ABAgAkLs2L2blozdt/IANwAIIAJC6drB+6aOnZDhADcAACACQR0QDCACQQo6AAAgAkEBEAwAC0GEBRANAAtSAgF/AX4jAEEQayIEJAAgASgCACACIAMgBEEEahAFAkACQCAELQAEDQBCAiEFDAELQgEgBDUCDEIghiAELQAIGyEFCyAAIAU3AgAgBEEQaiQAC5kBAQF/EBojAEEwayIBJAAgAEEARxASQZ0SEAsgAUG6wAA7AAogAUEKakECEAwgAUGhFDsALiABQeXwpaMHNgAqIAFCoMilo+btibogNwAiIAFC5dzRi8au2rfuADcAGiABQvTApOuGjtuy7QA3ABIgAULo3s2jh6SZvOkANwAKIAFBCmpBJhAMIAFBCjoACiABQQpqQQEQDAALBgAgABAGC38BAX8CQBAYQQJHDQBBAxAZQQBBAEEIQYCABBADIQBBBBAZIABBAjYCpDAgAEEANgIYIABC9c6hi8IANwMAAkBBJUUNACAAQcj/A2pBAEEl/AsACyAAQfXOoYsCNgL8/wMgAEGu3AA7Afj/AyAAQQA2AvD/AyAADwtBkxYQCAALPwECfyMAQRBrIgEkAAJAIABFDQAgAEEKbiICEBQgASACQfYBbCAAakEwcjoADyABQQ9qQQEQDAsgAUEQaiQACwYAIAAQFAsEACMBCwYAIAAkAQsEACMCCwYAIAAkAgslACMCQQBGBEBBASQCQQBBAEEIQYCABBADQYCABGokAEECJAILCwCnDgRuYW1lAeUNGwBJX1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxMjR3YXNpX2NsaV9nZXRfZW52aXJvbm1lbnQxN2hkYTc1MTA3MzQ0ZTY1NzJjRQGtAV9aTjEzN18kTFQkd2FzaV9zbmFwc2hvdF9wcmV2aWV3MS4uYmluZGluZ3MuLndhc2kuLmlvLi5zdHJlYW1zLi5PdXRwdXRTdHJlYW0kdTIwJGFzJHUyMCR3YXNpX3NuYXBzaG90X3ByZXZpZXcxLi5iaW5kaW5ncy4uX3J0Li5XYXNtUmVzb3VyY2UkR1QkNGRyb3A0ZHJvcDE3aGM1OTJlYzI2ZDA3YjhiMjRFAqQBX1pOMTI4XyRMVCR3YXNpX3NuYXBzaG90X3ByZXZpZXcxLi5iaW5kaW5ncy4ud2FzaS4uaW8uLmVycm9yLi5FcnJvciR1MjAkYXMkdTIwJHdhc2lfc25hcHNob3RfcHJldmlldzEuLmJpbmRpbmdzLi5fcnQuLldhc21SZXNvdXJjZSRHVCQ0ZHJvcDRkcm9wMTdoMTIzYTU0YzM4MmNkNzJlNEUDR19aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MTVTdGF0ZTNuZXcxMmNhYmlfcmVhbGxvYzE3aDVhNjNiYjNjMmMzY2I0ZWJFBGFfWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE4YmluZGluZ3M0d2FzaTNjbGk2c3RkZXJyMTBnZXRfc3RkZXJyMTF3aXRfaW1wb3J0MDE3aGMzZGEzN2IwYTVlNzY1ZTBFBX1fWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE4YmluZGluZ3M0d2FzaTJpbzdzdHJlYW1zMTJPdXRwdXRTdHJlYW0yNGJsb2NraW5nX3dyaXRlX2FuZF9mbHVzaDExd2l0X2ltcG9ydDIxN2g2ZmY1ZjQxMWYwNWQwZWJhRQZYX1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxOGJpbmRpbmdzNHdhc2kzY2xpNGV4aXQ0ZXhpdDExd2l0X2ltcG9ydDExN2hhY2ZlMzk3MzVlODEwZGIyRQc5X1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxNVN0YXRlM3B0cjE3aDViNWRlNWU0Y2I0ODgzNjhFCENfWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE2bWFjcm9zMTFhc3NlcnRfZmFpbDE3aDMxZGJhNDJmMmZlOTBhMGZFCRNjYWJpX2ltcG9ydF9yZWFsbG9jCj9fWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE5QnVtcEFsbG9jNWFsbG9jMTdoZGRiZGQ1YjNmYzY3M2FkMkULSl9aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MTZtYWNyb3MxOGVwcmludF91bnJlYWNoYWJsZTE3aGY5YTEwOTNjMWI5YzExZWJFDDxfWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE2bWFjcm9zNXByaW50MTdoYTVmODllZTVkNjdjNjllY0UNQ19aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MTZtYWNyb3MxMXVucmVhY2hhYmxlMTdoNDc0MTMwNGI5MDY5YzQ2NkUOC2Vudmlyb25fZ2V0DxFlbnZpcm9uX3NpemVzX2dldBBwX1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxOGJpbmRpbmdzNHdhc2kyaW83c3RyZWFtczEyT3V0cHV0U3RyZWFtMjRibG9ja2luZ193cml0ZV9hbmRfZmx1c2gxN2gyMWUxODU4ODY1YTBkOTEwRREJcHJvY19leGl0EktfWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE4YmluZGluZ3M0d2FzaTNjbGk0ZXhpdDRleGl0MTdoZjlmODkwOGI3ZGE4MTc4NkUTOV9aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MTVTdGF0ZTNuZXcxN2gwYzcxOGFlNGE5MjdjZDQ4RRRTX1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxNm1hY3JvczEwZXByaW50X3UzMjE1ZXByaW50X3UzMl9pbXBsMTdoZGY1ODI0ZTNjOTgzOTMzM0UVQl9aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MTZtYWNyb3MxMGVwcmludF91MzIxN2g5OGE1N2VhMTQwYzM0ZDQ2RRYNZ2V0X3N0YXRlX3B0chcNc2V0X3N0YXRlX3B0chgUZ2V0X2FsbG9jYXRpb25fc3RhdGUZFHNldF9hbGxvY2F0aW9uX3N0YXRlGg5hbGxvY2F0ZV9zdGFjawc4AwAPX19zdGFja19wb2ludGVyARJpbnRlcm5hbF9zdGF0ZV9wdHICEGFsbG9jYXRpb25fc3RhdGUATQlwcm9kdWNlcnMCCGxhbmd1YWdlAQRSdXN0AAxwcm9jZXNzZWQtYnkBBXJ1c3RjHTEuODkuMCAoMjk0ODM4ODNlIDIwMjUtMDgtMDQp');
    const module2 = base64Compile('AGFzbQEAAAABQgpgAn9/AGAEf39/fwBgBH9/f38Bf2AFf39/f38Bf2AGf39/f39/AGADf35/AGAEf39/fwBgAX8AYAJ/fwF/YAF/AAMXFgAAAAECAwICAAAABAUGAQAHCAgJBwYEBQFwARYWB3AXATAAAAExAAEBMgACATMAAwE0AAQBNQAFATYABgE3AAcBOAAIATkACQIxMAAKAjExAAsCMTIADAIxMwANAjE0AA4CMTUADwIxNgAQAjE3ABECMTgAEgIxOQATAjIwABQCMjEAFQgkaW1wb3J0cwEACq8CFgsAIAAgAUEAEQAACwsAIAAgAUEBEQAACwsAIAAgAUECEQAACw8AIAAgASACIANBAxEBAAsPACAAIAEgAiADQQQRAgALEQAgACABIAIgAyAEQQURAwALDwAgACABIAIgA0EGEQIACw8AIAAgASACIANBBxECAAsLACAAIAFBCBEAAAsLACAAIAFBCREAAAsLACAAIAFBChEAAAsTACAAIAEgAiADIAQgBUELEQQACw0AIAAgASACQQwRBQALDwAgACABIAIgA0ENEQYACw8AIAAgASACIANBDhEBAAsLACAAIAFBDxEAAAsJACAAQRARBwALCwAgACABQRERCAALCwAgACABQRIRCAALCQAgAEETEQkACwkAIABBFBEHAAsPACAAIAEgAiADQRURBgALAC8JcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBDXdpdC1jb21wb25lbnQHMC4yNDAuMA');
    const module3 = base64Compile('AGFzbQEAAAABQgpgAn9/AGAEf39/fwBgBH9/f38Bf2AFf39/f38Bf2AGf39/f39/AGADf35/AGAEf39/fwBgAX8AYAJ/fwF/YAF/AAKKARcAATAAAAABMQAAAAEyAAAAATMAAQABNAACAAE1AAMAATYAAgABNwACAAE4AAAAATkAAAACMTAAAAACMTEABAACMTIABQACMTMABgACMTQAAQACMTUAAAACMTYABwACMTcACAACMTgACAACMTkACQACMjAABwACMjEABgAIJGltcG9ydHMBcAEWFgkcAQBBAAsWAAECAwQFBgcICQoLDA0ODxAREhMUFQAvCXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQ13aXQtY29tcG9uZW50BzAuMjQwLjA');
    ({ exports: exports0 } = yield instantiateCore(yield module2));
    ({ exports: exports1 } = yield instantiateCore(yield module0, {
      'wasi:cli/stderr@0.2.4': {
        'get-stderr': trampoline19,
      },
      'wasi:clocks/monotonic-clock@0.2.4': {
        'subscribe-duration': trampoline3,
      },
      'wasi:http/outgoing-handler@0.2.4': {
        handle: exports0['14'],
      },
      'wasi:http/types@0.2.4': {
        '[constructor]fields': trampoline0,
        '[constructor]outgoing-request': trampoline6,
        '[constructor]request-options': trampoline1,
        '[method]fields.append': exports0['11'],
        '[method]fields.entries': exports0['0'],
        '[method]future-incoming-response.get': exports0['10'],
        '[method]future-incoming-response.subscribe': trampoline8,
        '[method]incoming-body.stream': exports0['1'],
        '[method]incoming-response.consume': exports0['9'],
        '[method]incoming-response.headers': trampoline2,
        '[method]incoming-response.status': trampoline7,
        '[method]outgoing-body.write': exports0['2'],
        '[method]outgoing-request.body': exports0['8'],
        '[method]outgoing-request.set-authority': exports0['6'],
        '[method]outgoing-request.set-method': exports0['4'],
        '[method]outgoing-request.set-path-with-query': exports0['7'],
        '[method]outgoing-request.set-scheme': exports0['5'],
        '[resource-drop]fields': trampoline10,
        '[resource-drop]future-incoming-response': trampoline18,
        '[resource-drop]incoming-body': trampoline13,
        '[resource-drop]incoming-response': trampoline17,
        '[resource-drop]outgoing-body': trampoline14,
        '[resource-drop]outgoing-request': trampoline16,
        '[resource-drop]request-options': trampoline9,
        '[static]outgoing-body.finish': exports0['3'],
      },
      'wasi:io/error@0.2.4': {
        '[method]error.to-debug-string': exports0['15'],
        '[resource-drop]error': trampoline12,
      },
      'wasi:io/poll@0.2.4': {
        '[method]pollable.block': trampoline4,
        '[resource-drop]pollable': trampoline5,
      },
      'wasi:io/streams@0.2.4': {
        '[method]input-stream.blocking-read': exports0['12'],
        '[method]output-stream.blocking-write-and-flush': exports0['13'],
        '[resource-drop]input-stream': trampoline11,
        '[resource-drop]output-stream': trampoline15,
      },
      'wasi:random/insecure-seed@0.2.4': {
        'insecure-seed': exports0['16'],
      },
      wasi_snapshot_preview1: {
        environ_get: exports0['17'],
        environ_sizes_get: exports0['18'],
        proc_exit: exports0['19'],
      },
    }));
    ({ exports: exports2 } = yield instantiateCore(yield module1, {
      __main_module__: {
        cabi_realloc: exports1.cabi_realloc,
      },
      env: {
        memory: exports1.memory,
      },
      'wasi:cli/environment@0.2.6': {
        'get-environment': exports0['20'],
      },
      'wasi:cli/exit@0.2.6': {
        exit: trampoline20,
      },
      'wasi:cli/stderr@0.2.6': {
        'get-stderr': trampoline19,
      },
      'wasi:io/error@0.2.6': {
        '[resource-drop]error': trampoline12,
      },
      'wasi:io/streams@0.2.6': {
        '[method]output-stream.blocking-write-and-flush': exports0['21'],
        '[resource-drop]output-stream': trampoline15,
      },
    }));
    memory0 = exports1.memory;
    realloc0 = exports1.cabi_realloc;
    realloc1 = exports2.cabi_import_realloc;
    ({ exports: exports3 } = yield instantiateCore(yield module3, {
      '': {
        $imports: exports0.$imports,
        '0': trampoline21,
        '1': trampoline22,
        '10': trampoline31,
        '11': trampoline32,
        '12': trampoline33,
        '13': trampoline34,
        '14': trampoline35,
        '15': trampoline36,
        '16': trampoline37,
        '17': exports2.environ_get,
        '18': exports2.environ_sizes_get,
        '19': exports2.proc_exit,
        '2': trampoline23,
        '20': trampoline38,
        '21': trampoline34,
        '3': trampoline24,
        '4': trampoline25,
        '5': trampoline26,
        '6': trampoline27,
        '7': trampoline28,
        '8': trampoline29,
        '9': trampoline30,
      },
    }));
    postReturn0 = exports1.cabi_post_create;
    postReturn1 = exports1.cabi_post_poll;
    postReturn2 = exports1['cabi_post_get-history'];
    _initialized = true;
    exports1Create = exports1.create;
    exports1Destroy = exports1.destroy;
    exports1Send = exports1.send;
    exports1Poll = exports1.poll;
    exports1Cancel = exports1.cancel;
    exports1Plan = exports1.plan;
    exports1Execute = exports1.execute;
    exports1GetHistory = exports1['get-history'];
    exports1ClearHistory = exports1['clear-history'];
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

export { cancel, clearHistory, create, destroy, execute, getHistory, plan, poll, send,  }