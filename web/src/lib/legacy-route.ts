/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
const legacyOrigin = 'https://legacy-route.invalid'

const legacyConsoleRoutes: Record<string, string> = {
  '/console': '/dashboard',
  '/console/models': '/models',
  '/console/deployment': '/models/deployments',
  '/console/subscription': '/subscriptions',
  '/console/channel': '/channels',
  '/console/token': '/keys',
  '/console/playground': '/playground',
  '/console/redemption': '/redemption-codes',
  '/console/user': '/users',
  '/console/personal': '/profile',
  '/console/log': '/usage-logs',
  '/console/midjourney': '/usage-logs/drawing',
  '/console/task': '/usage-logs/task',
}

const legacySettingsTabs: Record<string, string> = {
  operation: '/system-settings/operations/behavior',
  dashboard: '/system-settings/content/dashboard',
  chats: '/system-settings/content/chat',
  drawing: '/system-settings/content/drawing',
  payment: '/system-settings/billing/payment',
  ratio: '/system-settings/billing/model-pricing',
  ratelimit: '/system-settings/security/rate-limit',
  models: '/system-settings/models/global',
  'model-deployment': '/system-settings/models/model-deployment',
  performance: '/system-settings/operations/performance',
  system: '/system-settings/site/system-info',
  other: '/system-settings/site/system-info',
}

function normalizeLegacyPath(pathname: string): string {
  if (pathname === '/') return pathname
  return pathname.replace(/\/+$/, '')
}

function buildTargetHref(targetPath: string, search: URLSearchParams, hash: string): string {
  const target = new URL(targetPath, legacyOrigin)
  search.forEach((value, key) => {
    target.searchParams.append(key, value)
  })
  target.hash = hash
  return `${target.pathname}${target.search}${target.hash}`
}

function liftHashRouter(source: URL): { url: URL; lifted: boolean } {
  if (
    (source.pathname === '/' || source.pathname === '') &&
    source.hash.startsWith('#/')
  ) {
    const inner = new URL(source.hash.slice(1), legacyOrigin)
    source.searchParams.forEach((value, key) => {
      if (!inner.searchParams.has(key)) inner.searchParams.append(key, value)
    })
    inner.hash = ''
    return { url: inner, lifted: true }
  }
  return { url: source, lifted: false }
}

function resolveLegacyPath(source: URL): string | null {
  const pathname = normalizeLegacyPath(source.pathname)
  if (pathname === '/login') {
    return buildTargetHref('/sign-in', source.searchParams, source.hash)
  }
  if (pathname === '/forbidden') {
    return buildTargetHref('/403', source.searchParams, source.hash)
  }
  if (pathname === '/console/topup') {
    return buildTargetHref('/wallet', source.searchParams, source.hash)
  }
  if (pathname === '/console/setting') {
    const tab = source.searchParams.get('tab') ?? ''
    const target = legacySettingsTabs[tab] ?? '/system-settings'
    return buildTargetHref(target, source.searchParams, source.hash)
  }
  if (pathname === '/console/chat') {
    return buildTargetHref('/dashboard', source.searchParams, source.hash)
  }
  if (pathname.startsWith('/console/chat/')) {
    const chatID = pathname.slice('/console/chat/'.length)
    return buildTargetHref(chatID ? `/chat/${chatID}` : '/dashboard', source.searchParams, source.hash)
  }

  const target = legacyConsoleRoutes[pathname]
  if (target) return buildTargetHref(target, source.searchParams, source.hash)
  if (pathname.startsWith('/console/')) {
    return buildTargetHref('/dashboard', source.searchParams, source.hash)
  }

  return null
}

export function resolveLegacyRoute(rawHref: string): string | null {
  let source: URL
  try {
    source = new URL(rawHref, legacyOrigin)
  } catch {
    return null
  }

  const lifted = liftHashRouter(source)
  const mapped = resolveLegacyPath(lifted.url)
  if (mapped) return mapped
  if (lifted.lifted) {
    const path = normalizeLegacyPath(lifted.url.pathname)
    return `${path}${lifted.url.search}`
  }
  return null
}
