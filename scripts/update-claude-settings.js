#!/usr/bin/env node
/**
 * Claude Code Proxy Settings Update Script
 * Backs up and updates ~/.claude/settings.json to use cc-proxy
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CLAUDE_SETTINGS = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'settings.json');
const CC_PROXY_URL = 'http://127.0.0.1:4181';
const BACKUP_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'backups');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' +
                   new Date().toTimeString().split(' ')[0].replace(/:/g, '');
const BACKUP_FILE = path.join(BACKUP_DIR, `settings.json.backup.${TIMESTAMP}`);

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(color, message) {
  console.log(`${color}${message}${colors.reset}`);
}

function validateJSON(jsonString) {
  try {
    JSON.parse(jsonString);
    return true;
  } catch (error) {
    return false;
  }
}

function main() {
  log(colors.blue, '=== Claude Code Proxy Settings Update ===');
  console.log('');

  // Create backup directory if it doesn't exist
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // Check if settings file exists
  if (!fs.existsSync(CLAUDE_SETTINGS)) {
    log(colors.red, `❌ Error: Settings file not found at ${CLAUDE_SETTINGS}`);
    process.exit(1);
  }

  // Create backup
  log(colors.yellow, '📁 Creating backup...');
  try {
    fs.copyFileSync(CLAUDE_SETTINGS, BACKUP_FILE);
    log(colors.green, `✅ Backup created: ${BACKUP_FILE}`);
  } catch (error) {
    log(colors.red, `❌ Error creating backup: ${error.message}`);
    process.exit(1);
  }
  console.log('');

  // Validate backup
  log(colors.yellow, '🔍 Validating backup...');
  const backupContent = fs.readFileSync(BACKUP_FILE, 'utf8');
  if (!validateJSON(backupContent)) {
    log(colors.red, '❌ Backup JSON is invalid');
    process.exit(1);
  }
  log(colors.green, '✅ Backup JSON is valid');
  console.log('');

  // Update settings
  log(colors.yellow, '⚙️  Updating settings for cc-proxy...');
  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));

    // Store current values for display
    const oldBaseUrl = settings.env?.ANTHROPIC_BASE_URL || 'not set';
    const oldAuthToken = settings.env?.ANTHROPIC_AUTH_TOKEN || 'not set';

    // Update settings
    if (!settings.env) {
      settings.env = {};
    }

    settings.env.ANTHROPIC_BASE_URL = CC_PROXY_URL;

    // Remove auth token as it's handled by the proxy
    if (settings.env.ANTHROPIC_AUTH_TOKEN) {
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    }

    // Write updated settings
    const updatedContent = JSON.stringify(settings, null, 2);
    fs.writeFileSync(CLAUDE_SETTINGS, updatedContent);

    log(colors.green, '✅ Settings updated successfully');
    console.log('');

    // Display changes
    log(colors.blue, '📊 Configuration changes:');
    log(colors.green, 'BEFORE:');
    console.log(`  ANTHROPIC_BASE_URL: ${oldBaseUrl}`);
    console.log(`  ANTHROPIC_AUTH_TOKEN: ${oldAuthToken}`);
    console.log('');

    log(colors.green, 'AFTER:');
    console.log(`  ANTHROPIC_BASE_URL: ${CC_PROXY_URL}`);
    console.log(`  ANTHROPIC_AUTH_TOKEN: removed (handled by proxy)`);
    console.log('');

  } catch (error) {
    log(colors.red, `❌ Error updating settings: ${error.message}`);
    process.exit(1);
  }

  // Summary
  log(colors.blue, '🎉 Update completed successfully!');
  console.log('');
  log(colors.blue, 'Summary:');
  console.log(`  • Backup: ${BACKUP_FILE}`);
  console.log(`  • Settings: ${CLAUDE_SETTINGS}`);
  console.log(`  • Proxy URL: ${CC_PROXY_URL}`);
  console.log('');

  log(colors.blue, '📝 Useful commands:');
  console.log('  # Check proxy health:');
  console.log(`  curl -s ${CC_PROXY_URL}/health | jq .`);
  console.log('');
  console.log('  # View usage stats:');
  console.log(`  curl -s ${CC_PROXY_URL}/usage | jq .`);
  console.log('');
  console.log('  # Restore backup if needed:');
  console.log(`  cp ${BACKUP_FILE} ${CLAUDE_SETTINGS}`);
  console.log('');

  log(colors.green, '✅ All done! Your Claude Code is now configured to use cc-proxy.');
}

// Run the script
main();