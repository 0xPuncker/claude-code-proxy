#!/usr/bin/env node
/**
 * Backup script to create timestamped backups of Claude Code settings
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Paths
const homeDir = os.homedir();
const claudeDir = path.join(homeDir, '.claude');
const settingsFile = path.join(claudeDir, 'settings.json');
const backupDir = path.join(claudeDir, 'backups');

/**
 * Create a backup of the settings file
 */
function backupSettings() {
  if (!fs.existsSync(settingsFile)) {
    console.log('ℹ️  No existing settings.json found');
    return false;
  }

  // Create backups directory
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Create backup filename with timestamp
  const now = new Date();
  const datePart = now.toISOString().split('T')[0];
  const timePart = now.toTimeString().split(' ')[0].replace(/:/g, '');
  const timestamp = `${datePart}_${timePart}`;
  const backupFile = path.join(backupDir, `settings.json.backup.${timestamp}`);

  // Copy settings file to backup
  try {
    fs.copyFileSync(settingsFile, backupFile);
    console.log(`✅ Backup created: ${backupFile}`);
    return backupFile;
  } catch (error) {
    console.error(`❌ Failed to create backup: ${error.message}`);
    throw error;
  }
}

/**
 * Main backup function
 */
function backup() {
  console.log('📦 Backup Claude Code Settings');
  console.log('');

  const backupFile = backupSettings();

  if (backupFile) {
    console.log('');
    console.log('✨ Backup created successfully!');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

// Run backup when executed directly
backup().catch((error) => {
  console.error('❌ Backup failed:', error.message);
  process.exit(1);
});

export { backup };
