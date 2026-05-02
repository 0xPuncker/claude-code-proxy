#!/usr/bin/env node
/**
 * Restore script to restore Claude Code settings from backup
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Paths
const homeDir = os.homedir();
const claudeDir = path.join(homeDir, '.claude');
const settingsFile = path.join(claudeDir, 'settings.json');
const backupDir = path.join(claudeDir, 'backups');

/**
 * Get latest backup file
 */
function getLatestBackup() {
  if (!fs.existsSync(backupDir)) {
    console.log('❌ No backup directory found');
    return null;
  }

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('settings.json.backup.'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log('❌ No backup files found');
    return null;
  }

  return path.join(backupDir, files[0]);
}

/**
 * Restore settings from backup
 */
function restoreSettings() {
  const backupFile = getLatestBackup();
  if (!backupFile) {
    return false;
  }

  console.log(`📦 Restoring from: ${backupFile}`);

  // Ensure .claude directory exists
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // Copy backup to settings.json
  try {
    fs.copyFileSync(backupFile, settingsFile);
    console.log(`✅ Settings restored to: ${settingsFile}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to restore: ${error.message}`);
    return false;
  }
}

/**
 * Main restore function
 */
function restore() {
  console.log('🔄 Restore Claude Code Settings');
  console.log('');

  if (restoreSettings()) {
    console.log('');
    console.log('✨ Settings restored successfully!');
    console.log('');
    console.log('🔄 Next steps:');
    console.log('   1. Restart Claude Code');
    console.log('   2. Your original settings have been restored');
    process.exit(0);
  } else {
    console.log('');
    console.log('❌ No backup found to restore from');
    process.exit(1);
  }
}

// Run restore when executed directly
restore().catch((error) => {
  console.error('❌ Restore failed:', error.message);
  process.exit(1);
});

export { restore };
