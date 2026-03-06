#!/usr/bin/env node
// Post-version hook: sync version from package.json → openclaw.plugin.json + SKILL.md
import { readFileSync, writeFileSync } from 'fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

const plugin = JSON.parse(readFileSync('openclaw.plugin.json', 'utf8'))
plugin.version = version
writeFileSync('openclaw.plugin.json', JSON.stringify(plugin, null, 2) + '\n')

let skill = readFileSync('skills/declaw/SKILL.md', 'utf8')
skill = skill.replace(/^version: .*/m, `version: ${version}`)
writeFileSync('skills/declaw/SKILL.md', skill)

console.log(`Synced version ${version} → openclaw.plugin.json, skills/declaw/SKILL.md`)
