#!/usr/bin/env node
/**
 * Setup script to configure Claude Code to use the Claude Code Proxy
 * This script backs up your current settings and adds the proxy configuration
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROXY_PORT = process.env.PROXY_PORT || '4181';
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

// Paths
const homeDir = os.homedir();
const claudeDir = path.join(homeDir, '.claude');
const settingsFile = path.join(claudeDir, 'settings.json');
const backupDir = path.join(claudeDir, 'backups');

/**
 * Get platform-specific sed command
 */
function getSedCommand() {
  // On Windows, use PowerShell for JSON manipulation
  if (process.platform === 'win32') {
    return 'powershell -Command';
  }
  return 'sed -i';
}

/**
 * Create a backup of the settings file
 */
function backupSettings() {
  if (!fs.existsSync(settingsFile)) {
    console.log('ℹ️  No existing settings.json found - will create new file');
    return null;
  }

  // Create backups directory
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Create backup filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const backupFile = path.join(backupDir, `settings.json.backup.${timestamp}`);

  // Copy settings file
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
 * Check if settings.json already has proxy configured
 */
function isProxyConfigured(settings) {
  if (!settings) return false;

  // Check for various ways the proxy might be configured
  if (settings.env?.ANTHROPIC_API_URL?.includes('127.0.0.1:4181')) return true;
  if (settings.apiUrl?.includes('127.0.0.1:4181')) return true;

  return false;
}

/**
 * Add proxy configuration to settings
 */
function addProxyConfig(settings) {
  // Initialize settings if undefined
  if (!settings) {
    settings = {};
  }

  // Add env section if it doesn't exist
  if (!settings.env) {
    settings.env = {};
  }

  // Set the proxy URL
  settings.env.ANTHROPIC_API_URL = PROXY_URL;

  return settings;
}

/**
 * Write settings to file with pretty formatting
 */
function writeSettings(settings) {
  const settingsJson = JSON.stringify(settings, null, 2);

  // Ensure .claude directory exists
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  fs.writeFileSync(settingsFile, settingsJson, 'utf8');
  console.log(`✅ Settings written to: ${settingsFile}`);
}

/**
 * Main setup function
 */
function setup() {
  console.log('🔧 Claude Code Proxy Setup');
  console.log('');
  console.log(`Proxy URL: ${PROXY_URL}`);
  console.log('');

  // Backup existing settings
  console.log('📦 Backing up current settings...');
  const backupFile = backupSettings();

  // Read existing settings (if any)
  let settings;
  if (fs.existsSync(settingsFile)) {
    try {
      const content = fs.readFileSync(settingsFile, 'utf8');
      settings = JSON.parse(content);
    } catch (error) {
      console.warn(`⚠️  Could not parse existing settings.json: ${error.message}`);
      console.log('   Will create a new settings file');
      settings = null;
    }
  }

  // Check if already configured
  if (settings && isProxyConfigured(settings)) {
    console.log('✅ Proxy is already configured in your settings.json');
    console.log('   No changes needed.');
    return true;
  }

  // Add proxy configuration
  console.log('⚙️  Adding proxy configuration...');
  settings = addProxyConfig(settings);

  // Write new settings
  writeSettings(settings);

  console.log('');
  console.log('✨ Setup complete!');
  console.log('');
  console.log('Your Claude Code will now use the proxy at:', PROXY_URL);
  console.log('');

  if (backupFile) {
    console.log('💡 To restore your original settings:');
    console.log(`   npm run settings:restore`);
    console.log('');
  }

  console.log('🔄 Next steps:');
  console.log('   1. Restart Claude Code');
  console.log('   2. Try running your commands again');
  console.log('');
  console.log('📊 Check proxy status:');
  console.log(`   curl ${PROXY_URL}/health`);
  console.log(`   curl ${PROXY_URL}/providers`);

  return true;
}

// Run setup when executed directly
try {
  setup();
} catch (error) {
  console.error('❌ Setup failed:', error.message);
  process.exit(1);
}

export { setup };
