const assert = require('assert')
const cp = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const IS_WINDOWS = require('is-windows')()
const mkdirp = require('mkdirp')
const Module = require('module')
const path = require('path')
const rimraf = require('rimraf')
const signalExit = require('signal-exit')
const {IS_DEBUG, debug} = require('./debug')
const {homedir} = require('./homedir')
const {munge} = require('./munge')
const {getShim} = require('./shim/index')

function wrap (argv, env, workingDir) {
  const spawnSyncBinding = process.binding('spawn_sync')

  // if we're passed in the working dir, then it means that setup
  // was already done, so no need.
  const doSetup = !workingDir
  if (doSetup) {
    workingDir = setup(argv, env)
  }
  const spawn = cp.ChildProcess.prototype.spawn
  const spawnSync = spawnSyncBinding.spawn

  function unwrap () {
    if (doSetup && !IS_DEBUG) {
      rimraf.sync(workingDir)
    }
    cp.ChildProcess.prototype.spawn = spawn
    spawnSyncBinding.spawn = spawnSync
  }

  spawnSyncBinding.spawn = wrappedSpawnFunction(spawnSync, workingDir)
  cp.ChildProcess.prototype.spawn = wrappedSpawnFunction(spawn, workingDir)

  return unwrap
}

function wrappedSpawnFunction (fn, workingDir) {
  return wrappedSpawn

  function wrappedSpawn (options) {
    munge(workingDir, options)
    debug('WRAPPED', options)
    return fn.call(this, options)
  }
}

function setup (argv, env) {
  if (argv && typeof argv === 'object' && !env && !Array.isArray(argv)) {
    env = argv
    argv = []
  }

  if (!argv && !env) {
    throw new Error('at least one of "argv" and "env" required')
  }

  if (argv) {
    assert(Array.isArray(argv), 'argv must be an array')
  } else {
    argv = []
  }

  if (env) {
    assert(typeof env === 'object', 'env must be an object')
  } else {
    env = {}
  }

  debug('setup argv=%j env=%j', argv, env)

  // For stuff like --use_strict or --harmony, we need to inject
  // the argument *before* the wrap-main.
  const execArgv = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].match(/^-/)) {
      execArgv.push(argv[i])
      if (argv[i] === '-r' || argv[i] === '--require') {
        execArgv.push(argv[++i])
      }
    } else {
      break
    }
  }
  if (execArgv.length) {
    if (execArgv.length === argv.length) {
      argv.length = 0
    } else {
      argv = argv.slice(execArgv.length)
    }
  }

  let key = process.pid + '-' + crypto.randomBytes(6).toString('hex')
  let workingDir = homedir + key

  const settings = {
    module: require.resolve('../index'),
    deps: {
      foregroundChild: require.resolve('foreground-child'),
      signalExit: require.resolve('signal-exit')
    },
    isWindows: IS_WINDOWS,
    key: key,
    workingDir: workingDir,
    argv: argv,
    execArgv: execArgv,
    env: env,
    root: process.pid
  }
  const shim = getShim(settings)

  signalExit(function () {
    if (!IS_DEBUG) {
      rimraf.sync(workingDir)
    }
  })

  mkdirp.sync(workingDir)
  workingDir = fs.realpathSync(workingDir)
  if (isWindows()) {
    const cmdShim =
      '@echo off\r\n' +
      'SETLOCAL\r\n' +
      'SET PATHEXT=%PATHEXT:;.JS;=;%\r\n' +
      '"' + process.execPath + '"' + ' "%~dp0\\.\\node" %*\r\n'

    fs.writeFileSync(path.join(workingDir, 'node.cmd'), cmdShim)
    fs.chmodSync(path.join(workingDir, 'node.cmd'), '0755')
  }
  fs.writeFileSync(path.join(workingDir, 'node'), shim)
  fs.chmodSync(path.join(workingDir, 'node'), '0755')
  const cmdname = path.basename(process.execPath).replace(/\.exe$/i, '')
  if (cmdname !== 'node') {
    fs.writeFileSync(path.join(workingDir, cmdname), shim)
    fs.chmodSync(path.join(workingDir, cmdname), '0755')
  }

  return workingDir
}

function runMain () {
  process.argv.splice(1, 1)
  process.argv[1] = path.resolve(process.argv[1])
  delete require.cache[process.argv[1]]
  Module.runMain()
}

module.exports = {
  runMain,
  wrap
}