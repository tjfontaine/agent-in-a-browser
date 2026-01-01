import { environment, exit as exit$1, size, stderr, stdin, stdout, terminalInput, terminalOutput, terminalStderr, terminalStdin, terminalStdout } from '../../../../packages/wasi-shims/src/ghostty-cli-shim.js';
import { Fields, FutureIncomingResponse, IncomingBody, IncomingResponse, OutgoingBody, OutgoingRequest, RequestOptions, outgoingHandler } from '../../../../packages/wasi-shims/src/wasi-http-impl.js';
import { command } from '../mcp-server-jspi/ts-runtime-mcp.js';
import { preopens, types } from '@bytecodealliance/preview2-shim/filesystem';
import { error, poll, streams } from '@bytecodealliance/preview2-shim/io';
import { insecureSeed as insecureSeed$1 } from '@bytecodealliance/preview2-shim/random';
const { getEnvironment } = environment;
const { exit } = exit$1;
const { getTerminalSize } = size;
const { getStderr } = stderr;
const { getStdin } = stdin;
const { getStdout } = stdout;
const { TerminalInput } = terminalInput;
const { TerminalOutput } = terminalOutput;
const { getTerminalStderr } = terminalStderr;
const { getTerminalStdin } = terminalStdin;
const { getTerminalStdout } = terminalStdout;
const { handle } = outgoingHandler;
const { run } = command;
const { getDirectories } = preopens;
const { Descriptor,
  filesystemErrorCode } = types;
const { Error: Error$1 } = error;
const { Pollable } = poll;
const { InputStream,
  OutputStream } = streams;
const { insecureSeed } = insecureSeed$1;

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

const handleTable3 = [T_FLAG, 0];
const captureTable3= new Map();
let captureCnt3 = 0;
handleTables[3] = handleTable3;

function trampoline2() {
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

const handleTable2 = [T_FLAG, 0];
const captureTable2= new Map();
let captureCnt2 = 0;
handleTables[2] = handleTable2;

function trampoline3() {
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


function trampoline4() {
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

const handleTable0 = [T_FLAG, 0];
const captureTable0= new Map();
let captureCnt0 = 0;
handleTables[0] = handleTable0;

function trampoline5(arg0) {
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

const handleTable8 = [T_FLAG, 0];
const captureTable8= new Map();
let captureCnt8 = 0;
handleTables[8] = handleTable8;

function trampoline7(arg0) {
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
    const rep = ret[symbolRscRep] || ++captureCnt8;
    captureTable8.set(rep, ret);
    handle3 = rscTableCreateOwn(handleTable8, rep);
  }
  _debugLog('[iface="wasi:http/types@0.2.4", function="[constructor]outgoing-request"][Instruction::Return]', {
    funcName: '[constructor]outgoing-request',
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

function trampoline8(arg0) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
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

function trampoline9(arg0) {
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

let exports1;

function trampoline28(arg0) {
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

function trampoline29(arg0) {
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

const handleTable6 = [T_FLAG, 0];
const captureTable6= new Map();
let captureCnt6 = 0;
handleTables[6] = handleTable6;

function trampoline30(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable6.get(rep2);
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

const handleTable7 = [T_FLAG, 0];
const captureTable7= new Map();
let captureCnt7 = 0;
handleTables[7] = handleTable7;

function trampoline31(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable7.get(rep2);
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


function trampoline32(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable7.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingBody.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  else {
    captureTable7.delete(rep2);
  }
  rscTableRemove(handleTable7, handle1);
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


function trampoline33(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
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


function trampoline34(arg0, arg1, arg2, arg3, arg4) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
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


function trampoline35(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
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


function trampoline36(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
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


function trampoline37(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
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
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]outgoing-request.body"][Instruction::Return]', {
    funcName: '[method]outgoing-request.body',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline38(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
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
  _debugLog('[iface="wasi:http/types@0.2.4", function="[method]incoming-response.consume"][Instruction::Return]', {
    funcName: '[method]incoming-response.consume',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline39(arg0, arg1) {
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
              const rep = e[symbolRscRep] || ++captureCnt9;
              captureTable9.set(rep, e);
              handle3 = rscTableCreateOwn(handleTable9, rep);
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


function trampoline40(arg0, arg1, arg2, arg3, arg4, arg5) {
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


const trampoline41 = new WebAssembly.Suspending(async function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
  var ptr0 = arg0;
  var len0 = arg1;
  var result0 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr0, len0));
  var len2 = arg3;
  var base2 = arg2;
  var result2 = [];
  for (let i = 0; i < len2; i++) {
    const base = base2 + i * 8;
    var ptr1 = dataView(memory0).getUint32(base + 0, true);
    var len1 = dataView(memory0).getUint32(base + 4, true);
    var result1 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr1, len1));
    result2.push(result1);
  }
  var ptr3 = arg4;
  var len3 = arg5;
  var result3 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr3, len3));
  var len6 = arg7;
  var base6 = arg6;
  var result6 = [];
  for (let i = 0; i < len6; i++) {
    const base = base6 + i * 16;
    var ptr4 = dataView(memory0).getUint32(base + 0, true);
    var len4 = dataView(memory0).getUint32(base + 4, true);
    var result4 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr4, len4));
    var ptr5 = dataView(memory0).getUint32(base + 8, true);
    var len5 = dataView(memory0).getUint32(base + 12, true);
    var result5 = utf8Decoder.decode(new Uint8Array(memory0.buffer, ptr5, len5));
    result6.push([result4, result5]);
  }
  var handle8 = arg8;
  var rep9 = handleTable2[(handle8 << 1) + 1] & ~T_FLAG;
  var rsc7 = captureTable2.get(rep9);
  if (!rsc7) {
    rsc7 = Object.create(InputStream.prototype);
    Object.defineProperty(rsc7, symbolRscHandle, { writable: true, value: handle8});
    Object.defineProperty(rsc7, symbolRscRep, { writable: true, value: rep9});
  }
  else {
    captureTable2.delete(rep9);
  }
  rscTableRemove(handleTable2, handle8);
  var handle11 = arg9;
  var rep12 = handleTable3[(handle11 << 1) + 1] & ~T_FLAG;
  var rsc10 = captureTable3.get(rep12);
  if (!rsc10) {
    rsc10 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc10, symbolRscHandle, { writable: true, value: handle11});
    Object.defineProperty(rsc10, symbolRscRep, { writable: true, value: rep12});
  }
  else {
    captureTable3.delete(rep12);
  }
  rscTableRemove(handleTable3, handle11);
  var handle14 = arg10;
  var rep15 = handleTable3[(handle14 << 1) + 1] & ~T_FLAG;
  var rsc13 = captureTable3.get(rep15);
  if (!rsc13) {
    rsc13 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc13, symbolRscHandle, { writable: true, value: handle14});
    Object.defineProperty(rsc13, symbolRscRep, { writable: true, value: rep15});
  }
  else {
    captureTable3.delete(rep15);
  }
  rscTableRemove(handleTable3, handle14);
  _debugLog('[iface="shell:unix/command@0.1.0", function="run"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'run');
  const ret = await run(result0, result2, {
    cwd: result3,
    vars: result6,
  }, rsc7, rsc10, rsc13);
  _debugLog('[iface="shell:unix/command@0.1.0", function="run"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  _debugLog('[iface="shell:unix/command@0.1.0", function="run"][Instruction::Return]', {
    funcName: 'run',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return toInt32(ret);
}
);
const handleTable1 = [T_FLAG, 0];
const captureTable1= new Map();
let captureCnt1 = 0;
handleTables[1] = handleTable1;

const trampoline42 = new WebAssembly.Suspending(async function(arg0, arg1, arg2) {
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
    ret = { tag: 'ok', val: await rsc0.blockingRead(BigInt.asUintN(64, arg1))};
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
);

function trampoline43(arg0, arg1, arg2, arg3) {
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


function trampoline44(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutgoingRequest.prototype);
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


function trampoline45(arg0, arg1) {
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


function trampoline46(arg0) {
  _debugLog('[iface="terminal:info/size@0.1.0", function="get-terminal-size"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-terminal-size');
  const ret = getTerminalSize();
  _debugLog('[iface="terminal:info/size@0.1.0", function="get-terminal-size"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var {cols: v0_0, rows: v0_1 } = ret;
  dataView(memory0).setInt16(arg0 + 0, toUint16(v0_0), true);
  dataView(memory0).setInt16(arg0 + 2, toUint16(v0_1), true);
  _debugLog('[iface="terminal:info/size@0.1.0", function="get-terminal-size"][Instruction::Return]', {
    funcName: 'get-terminal-size',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


function trampoline47(arg0) {
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


function trampoline48(arg0, arg1) {
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

const handleTable14 = [T_FLAG, 0];
const captureTable14= new Map();
let captureCnt14 = 0;
handleTables[14] = handleTable14;

function trampoline49(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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


function trampoline50(arg0, arg1, arg2, arg3, arg4) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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


function trampoline51(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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
        const rep = e[symbolRscRep] || ++captureCnt14;
        captureTable14.set(rep, e);
        handle7 = rscTableCreateOwn(handleTable14, rep);
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


function trampoline52(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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


function trampoline53(arg0, arg1, arg2) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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


function trampoline54(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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


function trampoline55(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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


function trampoline56(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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


function trampoline57(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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


function trampoline58(arg0, arg1, arg2, arg3, arg4) {
  var handle1 = arg0;
  var rep2 = handleTable14[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable14.get(rep2);
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


const trampoline59 = new WebAssembly.Suspending(async function(arg0, arg1, arg2) {
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
    ret = { tag: 'ok', val: await rsc0.blockingRead(BigInt.asUintN(64, arg1))};
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
);

function trampoline60(arg0, arg1, arg2) {
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


function trampoline61(arg0, arg1) {
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


function trampoline62(arg0, arg1, arg2, arg3) {
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


function trampoline63(arg0, arg1) {
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


function trampoline64(arg0) {
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
      const rep = tuple0_0[symbolRscRep] || ++captureCnt14;
      captureTable14.set(rep, tuple0_0);
      handle1 = rscTableCreateOwn(handleTable14, rep);
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

const handleTable11 = [T_FLAG, 0];
const captureTable11= new Map();
let captureCnt11 = 0;
handleTables[11] = handleTable11;

function trampoline65(arg0) {
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
      const rep = e[symbolRscRep] || ++captureCnt11;
      captureTable11.set(rep, e);
      handle0 = rscTableCreateOwn(handleTable11, rep);
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

const handleTable12 = [T_FLAG, 0];
const captureTable12= new Map();
let captureCnt12 = 0;
handleTables[12] = handleTable12;

function trampoline66(arg0) {
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
      const rep = e[symbolRscRep] || ++captureCnt12;
      captureTable12.set(rep, e);
      handle0 = rscTableCreateOwn(handleTable12, rep);
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


function trampoline67(arg0) {
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
      const rep = e[symbolRscRep] || ++captureCnt12;
      captureTable12.set(rep, e);
      handle0 = rscTableCreateOwn(handleTable12, rep);
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
function trampoline6(handle) {
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
function trampoline11(handle) {
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
function trampoline12(handle) {
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
function trampoline13(handle) {
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
function trampoline14(handle) {
  const handleEntry = rscTableRemove(handleTable6, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable6.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable6.delete(handleEntry.rep);
    } else if (IncomingBody[symbolCabiDispose]) {
      IncomingBody[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline15(handle) {
  const handleEntry = rscTableRemove(handleTable7, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable7.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable7.delete(handleEntry.rep);
    } else if (OutgoingBody[symbolCabiDispose]) {
      OutgoingBody[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline16(handle) {
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
function trampoline17(handle) {
  const handleEntry = rscTableRemove(handleTable8, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable8.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable8.delete(handleEntry.rep);
    } else if (OutgoingRequest[symbolCabiDispose]) {
      OutgoingRequest[symbolCabiDispose](handleEntry.rep);
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
    } else if (IncomingResponse[symbolCabiDispose]) {
      IncomingResponse[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline19(handle) {
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
const handleTable15 = [T_FLAG, 0];
const captureTable15= new Map();
let captureCnt15 = 0;
handleTables[15] = handleTable15;
function trampoline20(handle) {
  const handleEntry = rscTableRemove(handleTable15, handle);
  if (handleEntry.own) {
    throw new TypeError('unreachable trampoline for resource [ResourceIndex(15)]')
  }
}
const handleTable16 = [T_FLAG, 0];
const captureTable16= new Map();
let captureCnt16 = 0;
handleTables[16] = handleTable16;
function trampoline21(handle) {
  const handleEntry = rscTableRemove(handleTable16, handle);
  if (handleEntry.own) {
    throw new TypeError('unreachable trampoline for resource [ResourceIndex(16)]')
  }
}
const handleTable17 = [T_FLAG, 0];
const captureTable17= new Map();
let captureCnt17 = 0;
handleTables[17] = handleTable17;
function trampoline22(handle) {
  const handleEntry = rscTableRemove(handleTable17, handle);
  if (handleEntry.own) {
    throw new TypeError('unreachable trampoline for resource [ResourceIndex(17)]')
  }
}
const handleTable18 = [T_FLAG, 0];
const captureTable18= new Map();
let captureCnt18 = 0;
handleTables[18] = handleTable18;
function trampoline23(handle) {
  const handleEntry = rscTableRemove(handleTable18, handle);
  if (handleEntry.own) {
    throw new TypeError('unreachable trampoline for resource [ResourceIndex(18)]')
  }
}
const handleTable13 = [T_FLAG, 0];
const captureTable13= new Map();
let captureCnt13 = 0;
handleTables[13] = handleTable13;
function trampoline24(handle) {
  const handleEntry = rscTableRemove(handleTable13, handle);
  if (handleEntry.own) {
    throw new TypeError('unreachable trampoline for resource [ResourceIndex(13)]')
  }
}
function trampoline25(handle) {
  const handleEntry = rscTableRemove(handleTable14, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable14.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable14.delete(handleEntry.rep);
    } else if (Descriptor[symbolCabiDispose]) {
      Descriptor[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline26(handle) {
  const handleEntry = rscTableRemove(handleTable11, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable11.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable11.delete(handleEntry.rep);
    } else if (TerminalInput[symbolCabiDispose]) {
      TerminalInput[symbolCabiDispose](handleEntry.rep);
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
    } else if (TerminalOutput[symbolCabiDispose]) {
      TerminalOutput[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let exports1Run;

async function run$1() {
  _debugLog('[iface="run", function="run"][Instruction::CallWasm] enter', {
    funcName: 'run',
    paramCount: 0,
    async: false,
    postReturn: false,
  });
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1Run');
  const ret = await exports1Run();
  endCurrentTask(0);
  _debugLog('[iface="run", function="run"][Instruction::Return]', {
    funcName: 'run',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  return ret;
}

const $init = (() => {
  let gen = (function* _initGenerator () {
    const module0 = fetchCompile(new URL('./web_agent_tui.core.wasm', import.meta.url));
    const module1 = fetchCompile(new URL('./web_agent_tui.core2.wasm', import.meta.url));
    const module2 = base64Compile('AGFzbQEAAAABjQESYAF/AGACf38AYAR/f39/AGAEf39/fwF/YAV/f39/fwF/YAZ/f39/f38AYAt/f39/f39/f39/fwF/YAN/fn8AYAR/f39/AGAEf39/fwF/YAN/f38Bf2AFf39/f38Bf2AJf39/f39+fn9/AX9gAn9/AX9gAX8Bf2ABfwBgBX9/f39/AGAHf39/f39/fwADNjUAAQECAwQDAwEBAQUGBwgCCQoLDA0JDQ0ODQoPDgEAAAEIEBEHBwEBAQEQBwcBCAEIAAAAAAQFAXABNTUHiwI2ATAAAAExAAEBMgACATMAAwE0AAQBNQAFATYABgE3AAcBOAAIATkACQIxMAAKAjExAAsCMTIADAIxMwANAjE0AA4CMTUADwIxNgAQAjE3ABECMTgAEgIxOQATAjIwABQCMjEAFQIyMgAWAjIzABcCMjQAGAIyNQAZAjI2ABoCMjcAGwIyOAAcAjI5AB0CMzAAHgIzMQAfAjMyACACMzMAIQIzNAAiAjM1ACMCMzYAJAIzNwAlAjM4ACYCMzkAJwI0MAAoAjQxACkCNDIAKgI0MwArAjQ0ACwCNDUALQI0NgAuAjQ3AC8CNDgAMAI0OQAxAjUwADICNTEAMwI1MgA0CCRpbXBvcnRzAQAK7QU1CQAgAEEAEQAACwsAIAAgAUEBEQEACwsAIAAgAUECEQEACw8AIAAgASACIANBAxECAAsPACAAIAEgAiADQQQRAwALEQAgACABIAIgAyAEQQURBAALDwAgACABIAIgA0EGEQMACw8AIAAgASACIANBBxEDAAsLACAAIAFBCBEBAAsLACAAIAFBCREBAAsLACAAIAFBChEBAAsTACAAIAEgAiADIAQgBUELEQUACx0AIAAgASACIAMgBCAFIAYgByAIIAkgCkEMEQYACw0AIAAgASACQQ0RBwALDwAgACABIAIgA0EOEQgACw8AIAAgASACIANBDxECAAsPACAAIAEgAiADQRARCQALDQAgACABIAJBEREKAAsRACAAIAEgAiADIARBEhELAAsZACAAIAEgAiADIAQgBSAGIAcgCEETEQwACwsAIAAgAUEUEQ0ACw8AIAAgASACIANBFREJAAsLACAAIAFBFhENAAsLACAAIAFBFxENAAsJACAAQRgRDgALCwAgACABQRkRDQALDQAgACABIAJBGhEKAAsJACAAQRsRDwALCQAgAEEcEQ4ACwsAIAAgAUEdEQEACwkAIABBHhEAAAsJACAAQR8RAAALCwAgACABQSARAQALDwAgACABIAIgA0EhEQgACxEAIAAgASACIAMgBEEiERAACxUAIAAgASACIAMgBCAFIAZBIxERAAsNACAAIAEgAkEkEQcACw0AIAAgASACQSURBwALCwAgACABQSYRAQALCwAgACABQScRAQALCwAgACABQSgRAQALCwAgACABQSkRAQALEQAgACABIAIgAyAEQSoREAALDQAgACABIAJBKxEHAAsNACAAIAEgAkEsEQcACwsAIAAgAUEtEQEACw8AIAAgASACIANBLhEIAAsLACAAIAFBLxEBAAsPACAAIAEgAiADQTARCAALCQAgAEExEQAACwkAIABBMhEAAAsJACAAQTMRAAALCQAgAEE0EQAACwAvCXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQ13aXQtY29tcG9uZW50BzAuMjM5LjAA7BgEbmFtZQATEndpdC1jb21wb25lbnQ6c2hpbQHPGDUANmluZGlyZWN0LXdhc2k6cmFuZG9tL2luc2VjdXJlLXNlZWRAMC4yLjQtaW5zZWN1cmUtc2VlZAE7aW5kaXJlY3Qtd2FzaTpodHRwL3R5cGVzQDAuMi40LVttZXRob2RdaW5jb21pbmctYm9keS5zdHJlYW0COmluZGlyZWN0LXdhc2k6aHR0cC90eXBlc0AwLjIuNC1bbWV0aG9kXW91dGdvaW5nLWJvZHkud3JpdGUDO2luZGlyZWN0LXdhc2k6aHR0cC90eXBlc0AwLjIuNC1bc3RhdGljXW91dGdvaW5nLWJvZHkuZmluaXNoBEJpbmRpcmVjdC13YXNpOmh0dHAvdHlwZXNAMC4yLjQtW21ldGhvZF1vdXRnb2luZy1yZXF1ZXN0LnNldC1tZXRob2QFQmluZGlyZWN0LXdhc2k6aHR0cC90eXBlc0AwLjIuNC1bbWV0aG9kXW91dGdvaW5nLXJlcXVlc3Quc2V0LXNjaGVtZQZFaW5kaXJlY3Qtd2FzaTpodHRwL3R5cGVzQDAuMi40LVttZXRob2Rdb3V0Z29pbmctcmVxdWVzdC5zZXQtYXV0aG9yaXR5B0tpbmRpcmVjdC13YXNpOmh0dHAvdHlwZXNAMC4yLjQtW21ldGhvZF1vdXRnb2luZy1yZXF1ZXN0LnNldC1wYXRoLXdpdGgtcXVlcnkIPGluZGlyZWN0LXdhc2k6aHR0cC90eXBlc0AwLjIuNC1bbWV0aG9kXW91dGdvaW5nLXJlcXVlc3QuYm9keQlAaW5kaXJlY3Qtd2FzaTpodHRwL3R5cGVzQDAuMi40LVttZXRob2RdaW5jb21pbmctcmVzcG9uc2UuY29uc3VtZQpDaW5kaXJlY3Qtd2FzaTpodHRwL3R5cGVzQDAuMi40LVttZXRob2RdZnV0dXJlLWluY29taW5nLXJlc3BvbnNlLmdldAs0aW5kaXJlY3Qtd2FzaTpodHRwL3R5cGVzQDAuMi40LVttZXRob2RdZmllbGRzLmFwcGVuZAwlaW5kaXJlY3Qtc2hlbGw6dW5peC9jb21tYW5kQDAuMS4wLXJ1bg1BaW5kaXJlY3Qtd2FzaTppby9zdHJlYW1zQDAuMi40LVttZXRob2RdaW5wdXQtc3RyZWFtLmJsb2NraW5nLXJlYWQOTWluZGlyZWN0LXdhc2k6aW8vc3RyZWFtc0AwLjIuNC1bbWV0aG9kXW91dHB1dC1zdHJlYW0uYmxvY2tpbmctd3JpdGUtYW5kLWZsdXNoDzBpbmRpcmVjdC13YXNpOmh0dHAvb3V0Z29pbmctaGFuZGxlckAwLjIuNC1oYW5kbGUQJWFkYXB0LXdhc2lfc25hcHNob3RfcHJldmlldzEtZmRfd3JpdGURMmFkYXB0LXdhc2lfc25hcHNob3RfcHJldmlldzEtcGF0aF9jcmVhdGVfZGlyZWN0b3J5Ei5hZGFwdC13YXNpX3NuYXBzaG90X3ByZXZpZXcxLXBhdGhfZmlsZXN0YXRfZ2V0EyZhZGFwdC13YXNpX3NuYXBzaG90X3ByZXZpZXcxLXBhdGhfb3BlbhQsYWRhcHQtd2FzaV9zbmFwc2hvdF9wcmV2aWV3MS1mZF9maWxlc3RhdF9nZXQVJGFkYXB0LXdhc2lfc25hcHNob3RfcHJldmlldzEtZmRfcmVhZBYoYWRhcHQtd2FzaV9zbmFwc2hvdF9wcmV2aWV3MS1lbnZpcm9uX2dldBcuYWRhcHQtd2FzaV9zbmFwc2hvdF9wcmV2aWV3MS1lbnZpcm9uX3NpemVzX2dldBglYWRhcHQtd2FzaV9zbmFwc2hvdF9wcmV2aWV3MS1mZF9jbG9zZRkrYWRhcHQtd2FzaV9zbmFwc2hvdF9wcmV2aWV3MS1mZF9wcmVzdGF0X2dldBowYWRhcHQtd2FzaV9zbmFwc2hvdF9wcmV2aWV3MS1mZF9wcmVzdGF0X2Rpcl9uYW1lGyZhZGFwdC13YXNpX3NuYXBzaG90X3ByZXZpZXcxLXByb2NfZXhpdBwwYWRhcHQtd2FzaV9zbmFwc2hvdF9wcmV2aWV3MS1hZGFwdGVyX2Nsb3NlX2JhZGZkHTppbmRpcmVjdC13YXNpOmlvL2Vycm9yQDAuMi40LVttZXRob2RdZXJyb3IudG8tZGVidWctc3RyaW5nHjNpbmRpcmVjdC10ZXJtaW5hbDppbmZvL3NpemVAMC4xLjAtZ2V0LXRlcm1pbmFsLXNpemUfM2luZGlyZWN0LXdhc2k6Y2xpL2Vudmlyb25tZW50QDAuMi42LWdldC1lbnZpcm9ubWVudCA6aW5kaXJlY3Qtd2FzaTpmaWxlc3lzdGVtL3R5cGVzQDAuMi42LWZpbGVzeXN0ZW0tZXJyb3ItY29kZSFLaW5kaXJlY3Qtd2FzaTpmaWxlc3lzdGVtL3R5cGVzQDAuMi42LVttZXRob2RdZGVzY3JpcHRvci5jcmVhdGUtZGlyZWN0b3J5LWF0Ij9pbmRpcmVjdC13YXNpOmZpbGVzeXN0ZW0vdHlwZXNAMC4yLjYtW21ldGhvZF1kZXNjcmlwdG9yLnN0YXQtYXQjP2luZGlyZWN0LXdhc2k6ZmlsZXN5c3RlbS90eXBlc0AwLjIuNi1bbWV0aG9kXWRlc2NyaXB0b3Iub3Blbi1hdCRHaW5kaXJlY3Qtd2FzaTpmaWxlc3lzdGVtL3R5cGVzQDAuMi42LVttZXRob2RdZGVzY3JpcHRvci5yZWFkLXZpYS1zdHJlYW0lSGluZGlyZWN0LXdhc2k6ZmlsZXN5c3RlbS90eXBlc0AwLjIuNi1bbWV0aG9kXWRlc2NyaXB0b3Iud3JpdGUtdmlhLXN0cmVhbSZJaW5kaXJlY3Qtd2FzaTpmaWxlc3lzdGVtL3R5cGVzQDAuMi42LVttZXRob2RdZGVzY3JpcHRvci5hcHBlbmQtdmlhLXN0cmVhbSdAaW5kaXJlY3Qtd2FzaTpmaWxlc3lzdGVtL3R5cGVzQDAuMi42LVttZXRob2RdZGVzY3JpcHRvci5nZXQtdHlwZSg8aW5kaXJlY3Qtd2FzaTpmaWxlc3lzdGVtL3R5cGVzQDAuMi42LVttZXRob2RdZGVzY3JpcHRvci5zdGF0KUVpbmRpcmVjdC13YXNpOmZpbGVzeXN0ZW0vdHlwZXNAMC4yLjYtW21ldGhvZF1kZXNjcmlwdG9yLm1ldGFkYXRhLWhhc2gqSGluZGlyZWN0LXdhc2k6ZmlsZXN5c3RlbS90eXBlc0AwLjIuNi1bbWV0aG9kXWRlc2NyaXB0b3IubWV0YWRhdGEtaGFzaC1hdCtBaW5kaXJlY3Qtd2FzaTppby9zdHJlYW1zQDAuMi42LVttZXRob2RdaW5wdXQtc3RyZWFtLmJsb2NraW5nLXJlYWQsOGluZGlyZWN0LXdhc2k6aW8vc3RyZWFtc0AwLjIuNi1bbWV0aG9kXWlucHV0LXN0cmVhbS5yZWFkLUBpbmRpcmVjdC13YXNpOmlvL3N0cmVhbXNAMC4yLjYtW21ldGhvZF1vdXRwdXQtc3RyZWFtLmNoZWNrLXdyaXRlLjppbmRpcmVjdC13YXNpOmlvL3N0cmVhbXNAMC4yLjYtW21ldGhvZF1vdXRwdXQtc3RyZWFtLndyaXRlL0NpbmRpcmVjdC13YXNpOmlvL3N0cmVhbXNAMC4yLjYtW21ldGhvZF1vdXRwdXQtc3RyZWFtLmJsb2NraW5nLWZsdXNoME1pbmRpcmVjdC13YXNpOmlvL3N0cmVhbXNAMC4yLjYtW21ldGhvZF1vdXRwdXQtc3RyZWFtLmJsb2NraW5nLXdyaXRlLWFuZC1mbHVzaDE3aW5kaXJlY3Qtd2FzaTpmaWxlc3lzdGVtL3ByZW9wZW5zQDAuMi42LWdldC1kaXJlY3RvcmllczI5aW5kaXJlY3Qtd2FzaTpjbGkvdGVybWluYWwtc3RkaW5AMC4yLjYtZ2V0LXRlcm1pbmFsLXN0ZGluMztpbmRpcmVjdC13YXNpOmNsaS90ZXJtaW5hbC1zdGRvdXRAMC4yLjYtZ2V0LXRlcm1pbmFsLXN0ZG91dDQ7aW5kaXJlY3Qtd2FzaTpjbGkvdGVybWluYWwtc3RkZXJyQDAuMi42LWdldC10ZXJtaW5hbC1zdGRlcnI');
    const module3 = base64Compile('AGFzbQEAAAABjQESYAF/AGACf38AYAR/f39/AGAEf39/fwF/YAV/f39/fwF/YAZ/f39/f38AYAt/f39/f39/f39/fwF/YAN/fn8AYAR/f39/AGAEf39/fwF/YAN/f38Bf2AFf39/f38Bf2AJf39/f39+fn9/AX9gAn9/AX9gAX8Bf2ABfwBgBX9/f39/AGAHf39/f39/fwACxAI2AAEwAAAAATEAAQABMgABAAEzAAIAATQAAwABNQAEAAE2AAMAATcAAwABOAABAAE5AAEAAjEwAAEAAjExAAUAAjEyAAYAAjEzAAcAAjE0AAgAAjE1AAIAAjE2AAkAAjE3AAoAAjE4AAsAAjE5AAwAAjIwAA0AAjIxAAkAAjIyAA0AAjIzAA0AAjI0AA4AAjI1AA0AAjI2AAoAAjI3AA8AAjI4AA4AAjI5AAEAAjMwAAAAAjMxAAAAAjMyAAEAAjMzAAgAAjM0ABAAAjM1ABEAAjM2AAcAAjM3AAcAAjM4AAEAAjM5AAEAAjQwAAEAAjQxAAEAAjQyABAAAjQzAAcAAjQ0AAcAAjQ1AAEAAjQ2AAgAAjQ3AAEAAjQ4AAgAAjQ5AAAAAjUwAAAAAjUxAAAAAjUyAAAACCRpbXBvcnRzAXABNTUJOwEAQQALNQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0AC8JcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBDXdpdC1jb21wb25lbnQHMC4yMzkuMAAcBG5hbWUAFRR3aXQtY29tcG9uZW50OmZpeHVwcw');
    ({ exports: exports0 } = yield instantiateCore(yield module2));
    ({ exports: exports1 } = yield instantiateCore(yield module0, {
      'shell:unix/command@0.1.0': {
        run: exports0['12'],
      },
      'terminal:info/size@0.1.0': {
        'get-terminal-size': exports0['30'],
      },
      'wasi:cli/stderr@0.2.4': {
        'get-stderr': trampoline4,
      },
      'wasi:cli/stdin@0.2.4': {
        'get-stdin': trampoline3,
      },
      'wasi:cli/stdout@0.2.4': {
        'get-stdout': trampoline2,
      },
      'wasi:http/outgoing-handler@0.2.4': {
        handle: exports0['15'],
      },
      'wasi:http/types@0.2.4': {
        '[constructor]fields': trampoline0,
        '[constructor]outgoing-request': trampoline7,
        '[constructor]request-options': trampoline1,
        '[method]fields.append': exports0['11'],
        '[method]future-incoming-response.get': exports0['10'],
        '[method]future-incoming-response.subscribe': trampoline9,
        '[method]incoming-body.stream': exports0['1'],
        '[method]incoming-response.consume': exports0['9'],
        '[method]incoming-response.status': trampoline8,
        '[method]outgoing-body.write': exports0['2'],
        '[method]outgoing-request.body': exports0['8'],
        '[method]outgoing-request.set-authority': exports0['6'],
        '[method]outgoing-request.set-method': exports0['4'],
        '[method]outgoing-request.set-path-with-query': exports0['7'],
        '[method]outgoing-request.set-scheme': exports0['5'],
        '[resource-drop]fields': trampoline11,
        '[resource-drop]future-incoming-response': trampoline19,
        '[resource-drop]incoming-body': trampoline14,
        '[resource-drop]incoming-response': trampoline18,
        '[resource-drop]outgoing-body': trampoline15,
        '[resource-drop]outgoing-request': trampoline17,
        '[resource-drop]request-options': trampoline6,
        '[static]outgoing-body.finish': exports0['3'],
      },
      'wasi:io/error@0.2.4': {
        '[method]error.to-debug-string': exports0['29'],
        '[resource-drop]error': trampoline13,
      },
      'wasi:io/poll@0.2.0': {
        '[resource-drop]pollable': trampoline10,
      },
      'wasi:io/poll@0.2.4': {
        '[method]pollable.block': trampoline5,
        '[resource-drop]pollable': trampoline10,
      },
      'wasi:io/streams@0.2.0': {
        '[resource-drop]input-stream': trampoline12,
        '[resource-drop]output-stream': trampoline16,
      },
      'wasi:io/streams@0.2.4': {
        '[method]input-stream.blocking-read': exports0['13'],
        '[method]output-stream.blocking-write-and-flush': exports0['14'],
        '[resource-drop]input-stream': trampoline12,
        '[resource-drop]output-stream': trampoline16,
      },
      'wasi:random/insecure-seed@0.2.4': {
        'insecure-seed': exports0['0'],
      },
      'wasi:sockets/tcp@0.2.0': {
        '[resource-drop]tcp-socket': trampoline23,
      },
      'wasi:sockets/udp@0.2.0': {
        '[resource-drop]incoming-datagram-stream': trampoline21,
        '[resource-drop]outgoing-datagram-stream': trampoline22,
        '[resource-drop]udp-socket': trampoline20,
      },
      wasi_snapshot_preview1: {
        adapter_close_badfd: exports0['28'],
        environ_get: exports0['22'],
        environ_sizes_get: exports0['23'],
        fd_close: exports0['24'],
        fd_filestat_get: exports0['20'],
        fd_prestat_dir_name: exports0['26'],
        fd_prestat_get: exports0['25'],
        fd_read: exports0['21'],
        fd_write: exports0['16'],
        path_create_directory: exports0['17'],
        path_filestat_get: exports0['18'],
        path_open: exports0['19'],
        proc_exit: exports0['27'],
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
        'get-environment': exports0['31'],
      },
      'wasi:cli/exit@0.2.6': {
        exit: trampoline28,
      },
      'wasi:cli/stderr@0.2.6': {
        'get-stderr': trampoline4,
      },
      'wasi:cli/stdin@0.2.6': {
        'get-stdin': trampoline3,
      },
      'wasi:cli/stdout@0.2.6': {
        'get-stdout': trampoline2,
      },
      'wasi:cli/terminal-input@0.2.6': {
        '[resource-drop]terminal-input': trampoline26,
      },
      'wasi:cli/terminal-output@0.2.6': {
        '[resource-drop]terminal-output': trampoline27,
      },
      'wasi:cli/terminal-stderr@0.2.6': {
        'get-terminal-stderr': exports0['52'],
      },
      'wasi:cli/terminal-stdin@0.2.6': {
        'get-terminal-stdin': exports0['50'],
      },
      'wasi:cli/terminal-stdout@0.2.6': {
        'get-terminal-stdout': exports0['51'],
      },
      'wasi:filesystem/preopens@0.2.6': {
        'get-directories': exports0['49'],
      },
      'wasi:filesystem/types@0.2.6': {
        '[method]descriptor.append-via-stream': exports0['38'],
        '[method]descriptor.create-directory-at': exports0['33'],
        '[method]descriptor.get-type': exports0['39'],
        '[method]descriptor.metadata-hash': exports0['41'],
        '[method]descriptor.metadata-hash-at': exports0['42'],
        '[method]descriptor.open-at': exports0['35'],
        '[method]descriptor.read-via-stream': exports0['36'],
        '[method]descriptor.stat': exports0['40'],
        '[method]descriptor.stat-at': exports0['34'],
        '[method]descriptor.write-via-stream': exports0['37'],
        '[resource-drop]descriptor': trampoline25,
        '[resource-drop]directory-entry-stream': trampoline24,
        'filesystem-error-code': exports0['32'],
      },
      'wasi:io/error@0.2.6': {
        '[resource-drop]error': trampoline13,
      },
      'wasi:io/streams@0.2.6': {
        '[method]input-stream.blocking-read': exports0['43'],
        '[method]input-stream.read': exports0['44'],
        '[method]output-stream.blocking-flush': exports0['47'],
        '[method]output-stream.blocking-write-and-flush': exports0['48'],
        '[method]output-stream.check-write': exports0['45'],
        '[method]output-stream.write': exports0['46'],
        '[resource-drop]input-stream': trampoline12,
        '[resource-drop]output-stream': trampoline16,
      },
    }));
    memory0 = exports1.memory;
    realloc0 = exports1.cabi_realloc;
    realloc1 = exports2.cabi_import_realloc;
    ({ exports: exports3 } = yield instantiateCore(yield module3, {
      '': {
        $imports: exports0.$imports,
        '0': trampoline29,
        '1': trampoline30,
        '10': trampoline39,
        '11': trampoline40,
        '12': trampoline41,
        '13': trampoline42,
        '14': trampoline43,
        '15': trampoline44,
        '16': exports2.fd_write,
        '17': exports2.path_create_directory,
        '18': exports2.path_filestat_get,
        '19': exports2.path_open,
        '2': trampoline31,
        '20': exports2.fd_filestat_get,
        '21': exports2.fd_read,
        '22': exports2.environ_get,
        '23': exports2.environ_sizes_get,
        '24': exports2.fd_close,
        '25': exports2.fd_prestat_get,
        '26': exports2.fd_prestat_dir_name,
        '27': exports2.proc_exit,
        '28': exports2.adapter_close_badfd,
        '29': trampoline45,
        '3': trampoline32,
        '30': trampoline46,
        '31': trampoline47,
        '32': trampoline48,
        '33': trampoline49,
        '34': trampoline50,
        '35': trampoline51,
        '36': trampoline52,
        '37': trampoline53,
        '38': trampoline54,
        '39': trampoline55,
        '4': trampoline33,
        '40': trampoline56,
        '41': trampoline57,
        '42': trampoline58,
        '43': trampoline59,
        '44': trampoline60,
        '45': trampoline61,
        '46': trampoline62,
        '47': trampoline63,
        '48': trampoline43,
        '49': trampoline64,
        '5': trampoline34,
        '50': trampoline65,
        '51': trampoline66,
        '52': trampoline67,
        '6': trampoline35,
        '7': trampoline36,
        '8': trampoline37,
        '9': trampoline38,
      },
    }));
    exports1Run = WebAssembly.promising(exports1.run);
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

await $init;

export { run$1 as run,  }