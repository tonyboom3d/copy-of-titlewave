import wixLocation from 'wix-location'
import { authentication } from 'wix-members-frontend'
import { local } from 'wix-storage-frontend'
import { appendOrderMessage, applyAdminDecisions, getFilteredProductOptions, getOrderForAdmin, getOrderForAdminCode, verifyOrderAndStatus } from 'backend/editLogics.web'
import { updateOrderLineItems } from 'backend/orderUpdates.web'
import { checkMemberRoles } from 'backend/adminAuth.web'

const IFRAME_URL = 'https://tonyboom3d.github.io/copy-of-titlewave/'
const IFRAME_ORIGIN = 'https://tonyboom3d.github.io'
const UI_HTML_ID = '#html1'
const ADMIN_SESSION_KEY = 'tw_admin_velo_token_v1'
const ADMIN_SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000

const LOG_NS = '[TW order iframe]'

function log(...args) {
    console.log(LOG_NS, ...args)
}

/** For logs only — avoids printing full email in console */
function maskEmail(email) {
    const s = (email || '').toString().trim()
    if (!s) return '(empty)'
    const at = s.indexOf('@')
    if (at < 1) return `${s.slice(0, 2)}…`
    const local = s.slice(0, at)
    const domain = s.slice(at + 1)
    return `${local.slice(0, 2)}…@${domain}`
}

/** For logs only */
function maskOrderRef(orderNumber) {
    const s = (orderNumber || '').toString().trim()
    if (!s.length) return '(empty)'
    if (s.length <= 4) return '…' + s.slice(-2)
    return `…${s.slice(-4)}`
}

function summarizeOutboundMessage(message) {
    if (!message || typeof message !== 'object') return message
    const { type, state, ...rest } = message
    if (type === 'TW_SET_STATE' && state) {
        return {
            type,
            orderNumber: state.order?.number,
            orderStatus: state.order?.status,
            itemCount: Array.isArray(state.items) ? state.items.length : 0,
            permissions: state.permissions,
            createdDate: state.order?.createdDate
        }
    }
    if (type === 'TW_INIT') {
        return { type, orderId: rest.orderId ?? message.orderId, isAdminMode: rest.isAdminMode ?? message.isAdminMode }
    }
    return { type, ...rest }
}

function summarizeInboundData(data) {
    if (!data || typeof data !== 'object') return data
    const t = data.type
    if (t === 'TW_AUTH_SUBMIT') {
        if ((data.mode || '').toString() === 'admin-code') {
            return {
                type: t,
                mode: 'admin-code',
                hasAdminCode: !!String(data.adminCode || '').trim()
            }
        }
        return {
            type: t,
            mode: 'customer',
            email: maskEmail(data.email),
            orderNumber: maskOrderRef(data.orderNumber)
        }
    }
    if (t === 'TW_SAVE_SUBMIT') {
        const changes = Array.isArray(data.changes) ? data.changes : []
        return {
            type: t,
            changeCount: changes.length,
            rowKeys: changes.map(c => (c && c.rowKey) ? String(c.rowKey) : '?').slice(0, 20)
        }
    }
    if (t === 'TW_ADMIN_LOGOUT') {
        return { type: t }
    }
    return { type: t }
}

const norm = x => Array.isArray(x) ? x : []
const lower = x => (x || '').toString().toLowerCase()
const textOr = (a, b) => a || b || ''
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function combineLegacyNameAndNumber(nameValue = '', numberValue = '') {
    const name = String(nameValue || '').trim()
    const number = String(numberValue || '').trim()
    if (name && number) return `${name} ${number}`
    return name || number || ''
}

function readAdminSession() {
    try {
        const raw = local.getItem(ADMIN_SESSION_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        const accessCode = String(parsed?.accessCode || '').trim()
        const expiresAt = Number(parsed?.expiresAt || 0)
        if (!accessCode || !expiresAt || expiresAt <= Date.now()) {
            local.removeItem(ADMIN_SESSION_KEY)
            return null
        }
        return { accessCode, expiresAt }
    } catch (error) {
        console.warn(LOG_NS, 'readAdminSession failed', error)
        return null
    }
}

function saveAdminSession(accessCode) {
    const normalized = String(accessCode || '').trim()
    if (!normalized) return
    try {
        local.setItem(ADMIN_SESSION_KEY, JSON.stringify({
            accessCode: normalized,
            expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
        }))
    } catch (error) {
        console.warn(LOG_NS, 'saveAdminSession failed', error)
    }
}

function clearAdminSession() {
    try {
        local.removeItem(ADMIN_SESSION_KEY)
    } catch (error) {
        console.warn(LOG_NS, 'clearAdminSession failed', error)
    }
}

function extractCustomTextFieldValue(fields, includeMatchers = [], excludeMatchers = []) {
    const arr = Array.isArray(fields) ? fields : []
    const hit = arr.find(field => {
        const title = lower(field?.title || field?.name || '')
        const includes = includeMatchers.some(m => title.includes(lower(m)))
        const excludes = excludeMatchers.some(m => title.includes(lower(m)))
        return includes && !excludes
    })
    return hit ? String(hit?.value || '').trim() : ''
}

let uiHtml = null
let currentOrderId = ''
let currentOrder = null
let currentIsAdminMode = false
let currentBypassTimeWindow = false
let currentAdminCode = ''
const productOptionsCache = new Map()

function postToUi(message) {
    if (!uiHtml) return
    uiHtml.postMessage(message, IFRAME_ORIGIN)
}

function descName(descLine) {
    return textOr(descLine?.name?.translated, descLine?.name?.original)
}

function descVal(descLine) {
    return textOr(
        descLine?.plainTextValue?.translated,
        textOr(
            descLine?.plainText?.translated,
            textOr(descLine?.plainTextValue?.original, descLine?.plainText?.original)
        )
    )
}

function extractSize(lines) {
    if (!Array.isArray(lines)) return ''
    const hit = lines.find(line => lower(descName(line)).includes('size'))
    return hit ? descVal(hit) : ''
}

function extractColor(lines) {
    if (!Array.isArray(lines)) return ''
    const hit = lines.find(line => line?.lineType === 'COLOR' || lower(descName(line)).includes('color'))
    if (!hit) return ''
    return textOr(hit?.colorInfo?.original, hit?.colorInfo?.translated) || (hit?.color || '')
}

function extractColorHex(lines) {
    if (!Array.isArray(lines)) return ''
    const hit = lines.find(line => line?.lineType === 'COLOR' || lower(descName(line)).includes('color'))
    if (!hit) return ''
    return textOr(
        hit?.colorInfo?.hex,
        textOr(hit?.colorInfo?.value, textOr(hit?.colorInfo?.code, hit?.color))
    )
}

function extractFieldValue(lines, matchers = []) {
    if (!Array.isArray(lines)) return ''
    const hit = lines.find(line => {
        const name = lower(descName(line))
        return matchers.some(m => name.includes(lower(m)))
    })
    return hit ? descVal(hit) : ''
}

function hasField(lines, matchers = []) {
    if (!Array.isArray(lines)) return false
    return lines.some(line => {
        const name = lower(descName(line))
        return matchers.some(m => name.includes(lower(m)))
    })
}

function extractNameNumber(lines, customTextFields = []) {
    const fromDescription = Array.isArray(lines) ? (() => {
        const hit = lines.find(line => {
            const name = lower(descName(line))
            if (name.includes('last name')) return false
            return name.includes('add player name') || name.includes('name / number') || name.includes('name') || name.includes('number')
        })
        return hit ? descVal(hit) : ''
    })() : ''
    if (String(fromDescription || '').trim()) return fromDescription
    return extractCustomTextFieldValue(customTextFields, ['name', 'number'], ['last name'])
}

function extractPlayerLastName(lines, customTextFields = []) {
    const fromDescription = extractFieldValue(lines, ['add player last name', 'player last name', 'last name'])
    if (String(fromDescription || '').trim()) return fromDescription
    return extractCustomTextFieldValue(customTextFields, ['last name'])
}

function wixImageToStatic(url) {
    if (!url || typeof url !== 'string') return ''
    if (!url.startsWith('wix:image://')) return url

    const base = url.split('#')[0]
    const after = base.startsWith('wix:image://v1/')
        ? base.slice('wix:image://v1/'.length)
        : base.replace('wix:image://', '')
    const mediaId = after.split('/')[0]

    return `https://static.wixstatic.com/media/${mediaId}`
}

function extractImageUrl(image) {
    if (!image) return ''
    if (typeof image === 'string') return wixImageToStatic(image)
    if (image.uri) return image.uri
    if (image.url) return image.url
    return ''
}

function buildRows(lineItems) {
    if (!Array.isArray(lineItems)) return []

    const rows = []

    lineItems.forEach((lineItem, itemIndex) => {
        const descriptionLines = lineItem?.descriptionLines || []
        const customTextFields = Array.isArray(lineItem?.customTextFields) ? lineItem.customTextFields : []
        const rawDescNames = descriptionLines.map(l => `${descName(l)}=${descVal(l)}`).join(' | ')
        const rawCtf = customTextFields.map(f => `${f?.title || f?.name}=${f?.value}`).join(' | ')
        const extractedNameNumber = extractNameNumber(descriptionLines, customTextFields)
        console.log('[TW items] item', itemIndex, 'nameNumber:', {
            result: extractedNameNumber,
            descLines: rawDescNames || '(none)',
            customFields: rawCtf || '(none)'
        })
        const hasNameNumberField = descriptionLines.some(line => {
            const name = lower(descName(line))
            if (name.includes('last name')) return false
            return name.includes('add player name') || name.includes('name / number') || name.includes('name') || name.includes('number')
        }) || !!extractCustomTextFieldValue(customTextFields, ['name', 'number'], ['last name'])
        const hasPlayerLastNameField =
            hasField(descriptionLines, ['add player last name', 'player last name', 'last name']) ||
            !!extractCustomTextFieldValue(customTextFields, ['last name'])
        const baseRow = {
            productId: lineItem?.catalogReference?.catalogItemId || lineItem?.rootCatalogItemId || '',
            image: extractImageUrl(lineItem?.image),
            productName: textOr(lineItem?.productName?.translated, lineItem?.productName?.original),
            size: extractSize(descriptionLines),
            color: extractColor(descriptionLines),
            colorLabel: extractColor(descriptionLines),
            colorHex: extractColorHex(descriptionLines),
            nameNumber: extractNameNumber(descriptionLines, customTextFields),
            playerLastName: extractPlayerLastName(descriptionLines, customTextFields),
            hasNameNumberField,
            hasPlayerLastNameField
        }

        const quantity = Math.max(1, Number(lineItem?.quantity) || 1)
        for (let quantityIndex = 0; quantityIndex < quantity; quantityIndex++) {
            rows.push({
                itemId: `${itemIndex}-${quantityIndex}`,
                rowKey: `${itemIndex}-${quantityIndex}`,
                ...baseRow,
                originalSize: baseRow.size,
                originalColor: baseRow.color,
                originalColorLabel: baseRow.colorLabel,
                originalColorHex: baseRow.colorHex,
                originalImage: baseRow.image,
                originalNameNumber: baseRow.nameNumber,
                originalPlayerLastName: baseRow.playerLastName,
                changes: [],
                lastChange: null
            })
        }
    })

    return rows
}

function buildRowsFromSavedItems(savedItems) {
    if (!Array.isArray(savedItems)) return []

    return savedItems.map((item, index) => ({
        itemId: (item?.itemId || `${index}`).toString(),
        rowKey: (item?.rowKey || `${index}`).toString(),
        productId: item?.productId || '',
        image: item?.image || '',
        productName: item?.productName || '',
        size: item?.size || '',
        color: item?.color || '',
        colorLabel: item?.colorLabel || item?.color || '',
        colorHex: item?.colorHex || '',
        status: item?.status || '',
        nameNumber: item?.nameNumber || combineLegacyNameAndNumber(item?.name, item?.number),
        playerLastName: item?.playerLastName || '',
        hasNameNumberField:
            !!item?.hasNameNumberField ||
            !!item?.nameNumber ||
            !!item?.originalNameNumber ||
            !!item?.name ||
            !!item?.number,
        hasPlayerLastNameField: !!item?.hasPlayerLastNameField || !!item?.playerLastName || !!item?.originalPlayerLastName,
        originalSize: item?.originalSize || item?.size || '',
        originalColor: item?.originalColor || item?.color || '',
        originalColorLabel: item?.originalColorLabel || item?.colorLabel || item?.color || '',
        originalColorHex: item?.originalColorHex || '',
        originalImage: item?.originalImage || item?.image || '',
        originalNameNumber: item?.originalNameNumber || item?.nameNumber || combineLegacyNameAndNumber(item?.originalName || item?.name, item?.originalNumber || item?.number),
        originalPlayerLastName: item?.originalPlayerLastName || item?.playerLastName || '',
        changes: Array.isArray(item?.changes) ? item.changes : [],
        lastChange: item?.lastChange || null
    }))
}

/**
 * CMS `newLineItems` / save payload often contains only changed rows, not the full order.
 * Merge those patches onto the canonical rows built from Wix `lineItems` by `rowKey`.
 */
function mergeSavedPatchesIntoRows(baseRows, savedItems) {
    if (!Array.isArray(savedItems) || savedItems.length === 0) return baseRows

    const byRowKey = new Map()
    for (const s of savedItems) {
        const rk = (s?.rowKey ?? '').toString()
        if (rk) byRowKey.set(rk, s)
    }

    return baseRows.map(row => {
        const patch = byRowKey.get((row.rowKey || '').toString())
        if (!patch) return row
        const patchNameNumber = patch.nameNumber != null
            ? patch.nameNumber
            : combineLegacyNameAndNumber(patch.name, patch.number)
        const patchOriginalNameNumber = patch.originalNameNumber != null
            ? patch.originalNameNumber
            : combineLegacyNameAndNumber(patch.originalName || patch.name, patch.originalNumber || patch.number)
        return {
            ...row,
            productId: patch.productId != null && String(patch.productId).length
                ? patch.productId
                : row.productId,
            image: patch.image != null && String(patch.image).length ? patch.image : row.image,
            productName:
                patch.productName != null && String(patch.productName).length
                    ? patch.productName
                    : row.productName,
            size: patch.size != null ? patch.size : row.size,
            color: patch.color != null ? patch.color : row.color,
            colorLabel: patch.colorLabel != null ? patch.colorLabel : row.colorLabel,
            colorHex: patch.colorHex != null ? patch.colorHex : row.colorHex,
            status: patch.status != null ? patch.status : row.status,
            nameNumber: patchNameNumber != null ? patchNameNumber : row.nameNumber,
            playerLastName: patch.playerLastName != null ? patch.playerLastName : row.playerLastName,
            hasNameNumberField:
                patch.hasNameNumberField != null
                    ? !!patch.hasNameNumberField
                    : (!!patchNameNumber || !!patch.name || !!patch.number || row.hasNameNumberField),
            hasPlayerLastNameField: patch.hasPlayerLastNameField != null ? !!patch.hasPlayerLastNameField : row.hasPlayerLastNameField,
            originalSize: row.originalSize,
            originalColor: row.originalColor,
            originalColorLabel: row.originalColorLabel,
            originalColorHex: row.originalColorHex,
            originalImage: row.originalImage,
            originalNameNumber: patchOriginalNameNumber != null && String(patchOriginalNameNumber).length ? patchOriginalNameNumber : row.originalNameNumber,
            originalPlayerLastName: row.originalPlayerLastName,
            changes: Array.isArray(patch.changes) ? patch.changes : (Array.isArray(row.changes) ? row.changes : []),
            lastChange: patch.lastChange != null ? patch.lastChange : row.lastChange
        }
    })
}

function dedupeOptions(options = [], keyBuilder = option => `${option?.value || ''}::${option?.label || ''}`) {
    const seen = new Set()
    const out = []
    for (const option of options || []) {
        const key = keyBuilder(option)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(option)
    }
    return out
}

function ensureOptionInList(options, value, fallback = value) {
    const normalizedValue = (value || '').toString()
    const normalizedFallback = (fallback || '').toString()
    if (!normalizedValue) return options
    const exists = options.some(option => {
        const optionValue = (option?.value || '').toString().toLowerCase()
        const optionLabel = (option?.label || option?.value || '').toString().toLowerCase()
        return (
            optionValue === normalizedValue.toLowerCase() ||
            (!!normalizedFallback && optionLabel === normalizedFallback.toLowerCase()) ||
            optionLabel === normalizedValue.toLowerCase()
        )
    })
    if (exists) return options
    return [{ value: normalizedValue, label: fallback || normalizedValue }, ...options]
}

function findMatchingColorOption(options, value, label = '') {
    const valueLower = (value || '').toString().toLowerCase()
    const labelLower = (label || '').toString().toLowerCase()

    return (options || []).find(option => {
        const optionValue = (option?.value || '').toString().toLowerCase()
        const optionLabel = (option?.label || '').toString().toLowerCase()
        return (
            (!!valueLower && (optionValue === valueLower || optionLabel === valueLower)) ||
            (!!labelLower && (optionValue === labelLower || optionLabel === labelLower))
        )
    }) || null
}

async function getProductOptionSets(productId, currentItem = {}) {
    const cacheKey = (productId || '').toString()
    if (!cacheKey) return { sizes: [], colors: [], hasSizeOptions: false, hasColorOptions: false }

    if (!productOptionsCache.has(cacheKey)) {
        log('loading product options', { productId: cacheKey })
        productOptionsCache.set(cacheKey, (async () => {
            const result = await getFilteredProductOptions(cacheKey)
            if (!result?.ok) {
                log('product options load failed', { productId: cacheKey, code: result?.code || '' })
                return { sizes: [], colors: [], hasSizeOptions: false, hasColorOptions: false }
            }

            const productOptions = result.productOptions || {}
            const sizeKey = Object.keys(productOptions).find(key => lower(key).includes('size'))
            const colorKey = Object.keys(productOptions).find(key => lower(key).includes('color'))

            const sizes = sizeKey
                ? dedupeOptions((productOptions[sizeKey]?.choices || []).map(choice => ({
                    value: choice?.value || '',
                    label: choice?.description || choice?.value || ''
                })).filter(choice => choice.value))
                : []

            const colors = colorKey
                ? dedupeOptions((productOptions[colorKey]?.choices || []).map(choice => ({
                    value: choice?.value || '',
                    label: choice?.description || choice?.value || '',
                    color: choice?.color || '',
                    image: choice?.mainMedia || ''
                })).filter(choice => choice.value), choice =>
                    `${choice?.value || ''}::${choice?.label || ''}::${choice?.color || ''}`
                )
                : []

            log('product options loaded', {
                productId: cacheKey,
                sizeCount: sizes.length,
                colorCount: colors.length
            })

            return {
                sizes,
                colors,
                hasSizeOptions: sizes.length > 0,
                hasColorOptions: colors.length > 0
            }
        })())
    }

    const optionSets = await productOptionsCache.get(cacheKey)
    const sizes = dedupeOptions(ensureOptionInList(optionSets.sizes || [], currentItem.size))
    const colors = dedupeOptions(ensureOptionInList(
        (optionSets.colors || []).map(color => ({ ...color, label: color.label || color.value || '' })),
        currentItem.color,
        currentItem.color
    ), choice => `${choice?.value || ''}::${choice?.label || ''}::${choice?.color || ''}`)

    return {
        sizes,
        colors,
        hasSizeOptions: !!optionSets.hasSizeOptions,
        hasColorOptions: !!optionSets.hasColorOptions
    }
}

async function buildUiItems(lineItems, savedItems = [], snapshotItems = []) {
    const fromOrder = buildRows(lineItems)
    let rows =
        fromOrder.length > 0
            ? mergeSavedPatchesIntoRows(fromOrder, savedItems)
            : buildRowsFromSavedItems(savedItems)

    // Fallback: enrich rows from CMS lineItems snapshot (has real 4-char itemId, name, number from export)
    if (snapshotItems.length > 0 && rows.length > 0) {
        const snapByProductId = new Map()
        for (const snap of snapshotItems) {
            const pid = String(snap?.productId || '').trim()
            if (!pid) continue
            if (!snapByProductId.has(pid)) snapByProductId.set(pid, [])
            snapByProductId.get(pid).push(snap)
        }
        const usedCountByPid = new Map()
        rows = rows.map(row => {
            const pid = String(row.productId || '').trim()
            if (!pid) return row
            const snaps = snapByProductId.get(pid) || []
            const usedCount = usedCountByPid.get(pid) || 0
            const snap = snaps[usedCount]
            if (!snap) return row
            usedCountByPid.set(pid, usedCount + 1)

            const snapItemId = String(snap?.itemId || '').trim()
            // Prefer the real 4-char itemId from export snapshot over the "0-1" index format
            const isIndexFormat = /^\d+-\d+$/.test(String(row.itemId || ''))
            const resolvedItemId = (isIndexFormat && snapItemId) ? snapItemId : (row.itemId || snapItemId)

            const nameNum = combineLegacyNameAndNumber(snap?.name, snap?.number)
            const lastName = String(snap?.playerLastName || '').trim()
            return {
                ...row,
                itemId: resolvedItemId,
                rowKey: row.rowKey, // keep rowKey unchanged for UI matching
                ...(nameNum && !String(row.nameNumber || '').trim() ? {
                    nameNumber: nameNum,
                    hasNameNumberField: true,
                    originalNameNumber: row.originalNameNumber || nameNum
                } : {}),
                ...(lastName && !String(row.playerLastName || '').trim() ? {
                    playerLastName: lastName,
                    hasPlayerLastNameField: true,
                    originalPlayerLastName: row.originalPlayerLastName || lastName
                } : {})
            }
        })
    }

    return Promise.all(rows.map(async row => {
        const optionSets = await getProductOptionSets(row.productId, row)
        const matchingColor = findMatchingColorOption(optionSets.colors || [], row.color, row.colorLabel)
        const originalMatchingColor = findMatchingColorOption(
            optionSets.colors || [],
            row.originalColor,
            row.originalColorLabel
        )
        const inferredColorHex = row.colorHex || matchingColor?.color || ((row.color || '').startsWith('#') ? row.color : '')
        const resolvedColorLabel = matchingColor?.label || row.colorLabel || row.color || ''
        const resolvedOriginalColorHex =
            row.originalColorHex ||
            originalMatchingColor?.color ||
            ((row.originalColor || '').startsWith('#') ? row.originalColor : '')
        const resolvedOriginalColorLabel =
            originalMatchingColor?.label ||
            row.originalColorLabel ||
            row.originalColor ||
            ''
        const resolvedOriginalImage = originalMatchingColor?.image || row.originalImage || ''
        const persistedChanged =
            String(row.size || '') !== String(row.originalSize || '') ||
            String(row.color || '') !== String(row.originalColor || '') ||
            String(resolvedColorLabel || '') !== String(resolvedOriginalColorLabel || '') ||
            String(inferredColorHex || '') !== String(resolvedOriginalColorHex || '') ||
            String((matchingColor?.image || row.image || '') || '') !== String(resolvedOriginalImage || '') ||
            String(row.nameNumber || '') !== String(row.originalNameNumber || '') ||
            String(row.playerLastName || '') !== String(row.originalPlayerLastName || '')

        return {
            ...row,
            colorLabel: resolvedColorLabel,
            colorHex: inferredColorHex,
            image: matchingColor?.image || row.image || '',
            status: row.status || '',
            optionSets,
            originalColorLabel: resolvedOriginalColorLabel,
            originalColorHex: resolvedOriginalColorHex,
            originalImage: resolvedOriginalImage,
            persistedChanged,
            changes: Array.isArray(row.changes) ? row.changes : [],
            lastChange: row.lastChange || null
        }
    }))
}

function formatAddress(address) {
    if (!address) return ''

    const street = [address?.streetAddress?.name, address?.streetAddress?.number].filter(Boolean).join(' ')
    const apt = address?.streetAddress?.apt ? `Apt ${address.streetAddress.apt}` : ''
    const city = address?.city || ''
    const country = address?.country || ''
    const postalCode = address?.postalCode || ''

    return [street, apt, city, country, postalCode].filter(Boolean).join(', ')
}

function normalizeStatus(status) {
    if (Array.isArray(status)) {
        const first = status.find(Boolean)
        return first ? String(first).trim() : ''
    }
    return String(status || '').trim()
}

function isWithinEditWindow(order, { bypassTimeWindow = false } = {}) {
    if (bypassTimeWindow) return true

    const createdDate = order?._createdDate || order?._dateCreated || ''
    if (!createdDate) return false

    const createdAtMs = new Date(createdDate).getTime()
    if (Number.isNaN(createdAtMs)) return false

    return (Date.now() - createdAtMs) <= (24 * 3600 * 1000)
}

function isEditingAllowed(order, { bypassTimeWindow = false } = {}) {
    const itemStatuses = getPerItemStatuses(order)
    if (itemStatuses.length) {
        const hasBlockingStatus = itemStatuses.some(status => {
            const lowerStatus = normalizeStatus(status).toLowerCase()
            return lowerStatus && lowerStatus !== 'pending' && lowerStatus !== 'pending (24h)' && lowerStatus !== 'open for edits'
        })
        return !hasBlockingStatus && isWithinEditWindow(order, { bypassTimeWindow })
    }

    const status = normalizeStatus(order?.orderStatus).toLowerCase()
    const isPendingStatus = status === '' || status === 'pending' || status === 'pending (24h)'
    return isPendingStatus && isWithinEditWindow(order, { bypassTimeWindow })
}

function getConsecutiveClientMessages(messages = []) {
    const arr = Array.isArray(messages) ? messages : []
    let count = 0
    for (let i = arr.length - 1; i >= 0; i--) {
        const role = String(arr[i]?.role || '').trim().toLowerCase()
        if (role === 'admin') break
        if (role === 'client' || role === 'user' || role === 'customer') {
            count += 1
            continue
        }
        break
    }
    return count
}

function getMessagingPermissions(order, { isAdminMode = false } = {}) {
    if (isAdminMode) {
        return { allowed: true, hint: '' }
    }

    const messages = Array.isArray(order?.msgForClient) ? order.msgForClient : []
    const consecutiveClientMessages = getConsecutiveClientMessages(messages)
    if (consecutiveClientMessages >= 2) {
        return {
            allowed: false,
            hint: 'Please wait for Customer Service to reply before sending another message.'
        }
    }

    return { allowed: true, hint: '' }
}

function getPerItemStatuses(order) {
    const sources = [
        ...(Array.isArray(order?.newLineItems) ? order.newLineItems : []),
        ...(Array.isArray(order?.lineItemsSnapshot) ? order.lineItemsSnapshot : [])
    ]
    const statuses = sources
        .map(item => normalizeStatus(item?.status))
        .filter(Boolean)
        .map(status => toUserFacingStatus(status))
    return Array.from(new Set(statuses))
}

function getDisplayStatus(order) {
    const itemStatuses = getPerItemStatuses(order).filter(status => status && status !== 'Open for edits')
    if (itemStatuses.length === 1) return itemStatuses[0]
    if (itemStatuses.length > 1) return itemStatuses.join(' / ')
    return toUserFacingStatus(order?.orderStatus) || 'Open for edits'
}

function toUserFacingStatus(status) {
    const normalized = normalizeStatus(status).toLowerCase()
    if (normalized === 'pending' || normalized === 'pending (24h)') return 'Open for edits'
    return normalizeStatus(status)
}

async function orderToUiState(order, { isAdminMode = false, bypassTimeWindow = false } = {}) {
    const firstName = order?.recipientInfo?.contactDetails?.firstName || ''
    const lastName = order?.recipientInfo?.contactDetails?.lastName || ''
    const items = await buildUiItems(order?.lineItems || [], order?.newLineItems || [], order?.lineItemsSnapshot || [])
    const messaging = getMessagingPermissions(order, { isAdminMode })

    return {
        order: {
            id: order?._id || '',
            number: order?.number || '',
            status: getDisplayStatus(order),
            createdDate: order?._createdDate || order?._dateCreated || '',
            messages: Array.isArray(order?.msgForClient) ? order.msgForClient : []
        },
        contact: {
            name: [firstName, lastName].filter(Boolean).join(' '),
            email: order?.buyerInfo?.email || '',
            phone: order?.recipientInfo?.contactDetails?.phone || ''
        },
        shipping: {
            address: formatAddress(order?.recipientInfo?.address)
        },
        items,
        permissions: {
            isAdminMode,
            bypassTimeWindow,
            editingAllowed: isEditingAllowed(order, { bypassTimeWindow }),
            messagingAllowed: messaging.allowed,
            messagingHint: messaging.hint
        }
    }
}

async function pushCurrentState() {
    if (!currentOrder) return
    const state = await orderToUiState(currentOrder, {
        isAdminMode: currentIsAdminMode,
        bypassTimeWindow: currentBypassTimeWindow
    })
    postToUi({
        type: 'TW_SET_STATE',
        state
    })
}

async function handleAdminMode() {
    const isLoggedIn = authentication.loggedIn()

    if (!isLoggedIn) {
        try {
            await authentication.promptLogin({ mode: 'login', modal: true })
        } catch (error) {
            console.error(LOG_NS, 'Admin login cancelled or failed:', error)
            return
        }
    }

    const roleCheck = await checkMemberRoles()

    if (!roleCheck?.ok || (!roleCheck.isAdmin && !roleCheck.isContributor && !roleCheck.isOwner)) {
        postToUi({
            type: 'TW_AUTH_RESULT',
            ok: false,
            message: 'Access denied: Admin permissions required'
        })
        return
    }

    const result = await getOrderForAdmin(currentOrderId)
    if (!result?.ok) {
        postToUi({
            type: 'TW_AUTH_RESULT',
            ok: false,
            message: 'Order not found'
        })
        return
    }

    currentOrder = result.order
    await pushCurrentState()
}

async function handleStoredAdminSession() {
    const session = readAdminSession()
    if (!session || !currentOrderId) return false

    const result = await getOrderForAdminCode(currentOrderId, session.accessCode)
    if (!result?.ok) {
        clearAdminSession()
        return false
    }

    currentIsAdminMode = true
    currentBypassTimeWindow = true
    currentAdminCode = session.accessCode
    currentOrder = result.order
    await pushCurrentState()
    return true
}

function buildUpdatePayload(changes) {
    const payload = changes.map(change => ({
        itemId: (change.itemId || '').toString() || uid(),
        rowKey: (change.rowKey || '').toString(),
        productId: (change.productId || '').toString(),
        productName: (change.productName || '').toString(),
        size: (change.size || '').toString(),
        color: (change.color || '').toString(),
        colorLabel: (change.colorLabel || '').toString(),
        colorHex: (change.colorHex || '').toString(),
        nameNumber: (change.nameNumber || '').toString(),
        playerLastName: (change.playerLastName || '').toString(),
        status: 'Waiting for Approval',
        image: (change.image || '').toString(),
        hasNameNumberField: !!change.hasNameNumberField,
        hasPlayerLastNameField: !!change.hasPlayerLastNameField,
        changes: Array.isArray(change.changes) ? change.changes : [],
        lastChange: change.lastChange || null
    }))
    return payload
}

$w.onReady(function () {
    uiHtml = $w(UI_HTML_ID)
    if (!uiHtml) return

    const path = norm(wixLocation.path)
    currentOrderId = path.length ? path[path.length - 1] : ''
    currentIsAdminMode = wixLocation.query.admin === 'true'
    currentBypassTimeWindow = currentIsAdminMode

    uiHtml.src = IFRAME_URL

    uiHtml.onMessage(async event => {
        const data = event?.data || {}
        if (!data?.type) return

        if (data.type === 'TW_READY') {
            const hasStoredAdminSession = !currentIsAdminMode && !!readAdminSession()
            const effectiveAdminMode = currentIsAdminMode || hasStoredAdminSession
            postToUi({
                type: 'TW_INIT',
                orderId: currentOrderId,
                isAdminMode: effectiveAdminMode
            })

            if (currentIsAdminMode) {
                await handleAdminMode()
            } else if (hasStoredAdminSession) {
                await handleStoredAdminSession()
            }
            return
        }

        if (data.type === 'TW_REQUEST_STATE') {
            if (currentOrder) {
                await pushCurrentState()
            } else {
                postToUi({
                    type: 'TW_INIT',
                    orderId: currentOrderId,
                    isAdminMode: currentIsAdminMode
                })
            }
            return
        }

        if (data.type === 'TW_AUTH_SUBMIT') {
            try {
                if ((data.mode || '').toString() === 'admin-code') {
                    const adminCode = (data.adminCode || '').toString().trim()

                    if (!currentOrderId || !adminCode) {
                        postToUi({
                            type: 'TW_AUTH_RESULT',
                            ok: false,
                            message: 'Missing admin code'
                        })
                        return
                    }

                    const result = await getOrderForAdminCode(currentOrderId, adminCode)
                    if (!result?.ok) {
                        postToUi({
                            type: 'TW_AUTH_RESULT',
                            ok: false,
                            message: result?.message || 'Invalid admin code'
                        })
                        return
                    }

                    currentIsAdminMode = true
                    currentBypassTimeWindow = true
                    currentAdminCode = adminCode
                    currentOrder = result.order
                    saveAdminSession(adminCode)

                    postToUi({ type: 'TW_AUTH_RESULT', ok: true })
                    await pushCurrentState()
                    return
                }

                const email = (data.email || '').toString().trim()
                const orderNumber = (data.orderNumber || '').toString().trim()

                if (!currentOrderId || !email || !orderNumber) {
                    postToUi({
                        type: 'TW_AUTH_RESULT',
                        ok: false,
                        message: 'Missing order number or email'
                    })
                    return
                }

                const result = await verifyOrderAndStatus(currentOrderId, email, orderNumber)
                if (!result?.ok) {
                    postToUi({
                        type: 'TW_AUTH_RESULT',
                        ok: false,
                        message: 'Access denied for the provided details'
                    })
                    return
                }

                currentOrder = result.order
                postToUi({ type: 'TW_AUTH_RESULT', ok: true })
                await pushCurrentState()
            } catch (error) {
                console.error(LOG_NS, 'verifyOrderAndStatus failed:', error)
                postToUi({
                    type: 'TW_AUTH_RESULT',
                    ok: false,
                    message: 'Verification failed. Please try again.'
                })
            }
            return
        }

        if (data.type === 'TW_SAVE_SUBMIT') {
            try {
                const changes = Array.isArray(data.changes) ? data.changes : []
                if (!currentOrderId) {
                    postToUi({
                        type: 'TW_SAVE_RESULT',
                        ok: false,
                        message: 'Order ID not found'
                    })
                    return
                }

                if (!isEditingAllowed(currentOrder, { bypassTimeWindow: currentBypassTimeWindow })) {
                    postToUi({
                        type: 'TW_SAVE_RESULT',
                        ok: false,
                        message: 'The 24-hour editing window has expired.'
                    })
                    postToUi({
                        type: 'TW_LOCK_EDITING',
                        locked: true,
                        reason: 'edit-window-expired'
                    })
                    return
                }

                if (!changes.length) {
                    postToUi({
                        type: 'TW_SAVE_RESULT',
                        ok: false,
                        message: 'No changes to save'
                    })
                    return
                }

                const payload = buildUpdatePayload(changes)
                const result = await updateOrderLineItems(currentOrderId, payload, {
                    bypassTimeWindow: currentBypassTimeWindow
                })

                if (!result?.ok) {
                    postToUi({
                        type: 'TW_SAVE_RESULT',
                        ok: false,
                        message: result?.message || 'Failed to update order'
                    })
                    return
                }

                if (currentOrder) {
                    currentOrder = {
                        ...currentOrder,
                        newLineItems: payload,
                        orderStatus: result.newStatus || 'waiting for approval'
                    }
                } else {
                    currentOrder = {
                        newLineItems: payload,
                        orderStatus: result.newStatus || 'waiting for approval'
                    }
                }

                postToUi({
                    type: 'TW_SAVE_RESULT',
                    ok: true,
                    newStatus: result.newStatus || 'waiting for approval'
                })
                await pushCurrentState()
                postToUi({
                    type: 'TW_LOCK_EDITING',
                    locked: true,
                    reason: 'waiting for approval'
                })
            } catch (error) {
                console.error(LOG_NS, 'updateOrderLineItems failed:', error)
                postToUi({
                    type: 'TW_SAVE_RESULT',
                    ok: false,
                    message: 'Error saving changes'
                })
            }
        }

        if (data.type === 'TW_ADMIN_DECISIONS_SUBMIT') {
            try {
                const decisions = Array.isArray(data.decisions) ? data.decisions : []
                if (!currentOrderId) {
                    postToUi({ type: 'TW_SAVE_RESULT', ok: false, message: 'Order ID not found' })
                    return
                }

                const res = await applyAdminDecisions(currentOrderId, decisions, '', currentAdminCode)
                if (!res?.ok) {
                    postToUi({ type: 'TW_SAVE_RESULT', ok: false, message: res?.message || 'Failed to apply admin decisions' })
                    return
                }

                // Refresh order snapshot for UI (keep admin path consistent)
                if (currentIsAdminMode) {
                    const fresh = currentAdminCode
                        ? await getOrderForAdminCode(currentOrderId, currentAdminCode)
                        : await getOrderForAdmin(currentOrderId)
                    if (fresh?.ok) currentOrder = fresh.order
                }

                postToUi({ type: 'TW_SAVE_RESULT', ok: true, newStatus: res.orderStatus || '' })
                await pushCurrentState()
            } catch (error) {
                console.error(LOG_NS, 'TW_ADMIN_DECISIONS_SUBMIT failed:', error)
                postToUi({ type: 'TW_SAVE_RESULT', ok: false, message: 'Error applying admin decisions' })
            }
            return
        }

        if (data.type === 'TW_MESSAGE_SUBMIT') {
            try {
                const text = String(data.text || '').trim()
                if (!text) return
                if (!currentOrderId) return
                if (!currentOrder) return

                const senderRole = currentIsAdminMode ? 'admin' : 'client'
                const senderName = currentIsAdminMode
                    ? 'Customer Service'
                    : (
                        [
                            currentOrder?.recipientInfo?.contactDetails?.firstName || '',
                            currentOrder?.recipientInfo?.contactDetails?.lastName || ''
                        ].filter(Boolean).join(' ') ||
                        currentOrder?.buyerInfo?.email ||
                        'Customer'
                    )

                const res = await appendOrderMessage(currentOrderId, text, senderName, senderRole)
                if (!res?.ok) {
                    postToUi({ type: 'TW_MESSAGE_RESULT', ok: false, message: 'Failed to send message' })
                    return
                }

                // update local order snapshot
                currentOrder = { ...(currentOrder || {}), msgForClient: res.msgForClient || [] }
                postToUi({ type: 'TW_MESSAGE_RESULT', ok: true })
                await pushCurrentState()
            } catch (error) {
                console.error(LOG_NS, 'TW_MESSAGE_SUBMIT failed:', error)
                postToUi({ type: 'TW_MESSAGE_RESULT', ok: false, message: 'Error sending message' })
            }
            return
        }

        if (data.type === 'TW_ADMIN_LOGOUT') {
            clearAdminSession()
            currentAdminCode = ''
            currentOrder = null
            currentBypassTimeWindow = false
            currentIsAdminMode = false
            postToUi({ type: 'TW_ADMIN_LOGOUT_RESULT', ok: true })
            return
        }
    })
})