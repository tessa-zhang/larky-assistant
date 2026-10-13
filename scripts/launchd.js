import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.inlark.listener';
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userHome = homedir();
const agentDir = join(userHome, 'Library', 'LaunchAgents');
const logDir = join(userHome, 'Library', 'Logs', 'inlark');
const plistPath = join(agentDir, `${LABEL}.plist`);
const stdoutPath = join(logDir, 'listener.log');
const stderrPath = join(logDir, 'listener.error.log');
const serviceTarget = `gui/${process.getuid()}/${LABEL}`;
const userTarget = `gui/${process.getuid()}`;

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function executablePath() {
  return [
    dirname(process.execPath),
    join(userHome, '.npm-global', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(projectDir, 'src', 'index.js'))}</string>
    <string>listen</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(userHome)}</string>
    <key>PATH</key>
    <string>${xml(executablePath())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: 'pipe' });
}

function bootoutIfLoaded() {
  try {
    launchctl('bootout', serviceTarget);
  } catch {
    // A service that is not loaded needs no cleanup.
  }
}

function install() {
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  bootoutIfLoaded();
  writeFileSync(plistPath, plist(), { mode: 0o600 });
  launchctl('bootstrap', userTarget, plistPath);
  console.log(`Installed and started ${LABEL}.`);
  console.log(`Config: ${plistPath}`);
  console.log(`Logs:   ${stdoutPath}`);
  console.log(`Errors: ${stderrPath}`);
}

function status() {
  try {
    process.stdout.write(launchctl('print', serviceTarget));
  } catch {
    console.error(`${LABEL} is not loaded. Run: npm run service:install`);
    process.exitCode = 1;
  }
}

function logs() {
  for (const path of [stdoutPath, stderrPath]) {
    console.log(`\n==> ${path} <==`);
    console.log(existsSync(path) ? readFileSync(path, 'utf8') : '(no log yet)');
  }
}

function uninstall() {
  bootoutIfLoaded();
  if (existsSync(plistPath)) unlinkSync(plistPath);
  console.log(`Stopped and removed ${LABEL}. Logs remain in ${logDir}.`);
}

const commands = { install, status, logs, uninstall, print: () => process.stdout.write(plist()) };
const command = process.argv[2];
if (!commands[command]) {
  console.error('Usage: node scripts/launchd.js <install|status|logs|uninstall|print>');
  process.exit(1);
}
commands[command]();
