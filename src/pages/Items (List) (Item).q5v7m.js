import wixLocation from 'wix-location'
import { authentication } from 'wix-members-frontend'
import { getFilteredProductOptions, getOrderForAdmin, verifyOrderAndStatus } from 'backend/editLogics.web'
import { updateOrderLineItems } from 'backend/orderUpdates.web'
import { checkMemberRoles } from 'backend/adminAuth.web'

const IFRAME_URL = 'https://tonyboom3d.github.io/copy-of-titlewave/'
const IFRAME_ORIGIN = 'https://tonyboom3d.github.io'
const UI_HTML_ID = '#html1'

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
        return {
            type: t,
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
    return { type: t }
}

const norm = x => Array.isArray(x) ? x : []
const lower = x => (x || '').toString().toLowerCase()
const textOr = (a, b) => a || b || ''
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

let uiHtml = null
let currentOrderId = ''
let currentOrder = null
let currentIsAdminMode = false
const productOptionsCache = new Map()

function postToUi(message) {
    if (!uiHtml) {
        log('postToUi skipped — no HTML component', summarizeOutboundMessage(message))
        return
    }
    log('→ iframe', summarizeOutboundMessage(message))
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

function extractNameNumber(lines) {
    if (!Array.isArray(lines)) return ''
    const hit = lines.find(line => {
        const name = lower(descName(line))
        return name.includes('name') || name.includes('number')
    })
    return hit ? descVal(hit) : ''
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
        const baseRow = {
            productId: lineItem?.catalogReference?.catalogItemId || lineItem?.rootCatalogItemId || '',
            image: extractImageUrl(lineItem?.image),
            productName: textOr(lineItem?.productName?.translated, lineItem?.productName?.original),
            size: extractSize(descriptionLines),
            color: extractColor(descriptionLines),
            colorHex: '',
            nameNumber: extractNameNumber(descriptionLines)
        }

        const quantity = Math.max(1, Number(lineItem?.quantity) || 1)
        for (let quantityIndex = 0; quantityIndex < quantity; quantityIndex++) {
            rows.push({
                itemId: `${itemIndex}-${quantityIndex}`,
                rowKey: `${itemIndex}-${quantityIndex}`,
                ...baseRow
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
        colorHex: item?.colorHex || '',
        nameNumber: item?.nameNumber || ''
    }))
}

function ensureOptionInList(options, value, fallback = value) {
    const normalizedValue = (value || '').toString()
    if (!normalizedValue) return options
    const exists = options.some(option => (option?.value || '').toString().toLowerCase() === normalizedValue.toLowerCase())
    if (exists) return options
    return [{ value: normalizedValue, label: fallback || normalizedValue }, ...options]
}

async function getProductOptionSets(productId, currentItem = {}) {
    const cacheKey = (productId || '').toString()
    if (!cacheKey) return { sizes: [], colors: [] }

    if (!productOptionsCache.has(cacheKey)) {
        log('loading product options', { productId: cacheKey })
        productOptionsCache.set(cacheKey, (async () => {
            const result = await getFilteredProductOptions(cacheKey)
            if (!result?.ok) {
                log('product options load failed', { productId: cacheKey, code: result?.code || '' })
                return { sizes: [], colors: [] }
            }

            const productOptions = result.productOptions || {}
            const sizeKey = Object.keys(productOptions).find(key => lower(key).includes('size'))
            const colorKey = Object.keys(productOptions).find(key => lower(key).includes('color'))

            const sizes = sizeKey
                ? (productOptions[sizeKey]?.choices || []).map(choice => ({
                    value: choice?.value || '',
                    label: choice?.description || choice?.value || ''
                })).filter(choice => choice.value)
                : []

            const colors = colorKey
                ? (productOptions[colorKey]?.choices || []).map(choice => ({
                    value: choice?.value || '',
                    label: choice?.description || choice?.value || '',
                    color: choice?.color || '',
                    image: choice?.mainMedia || ''
                })).filter(choice => choice.value)
                : []

            log('product options loaded', {
                productId: cacheKey,
                sizeCount: sizes.length,
                colorCount: colors.length
            })

            return { sizes, colors }
        })())
    }

    const optionSets = await productOptionsCache.get(cacheKey)
    const sizes = ensureOptionInList(optionSets.sizes || [], currentItem.size)
    const colors = ensureOptionInList(
        (optionSets.colors || []).map(color => ({ ...color, label: color.label || color.value || '' })),
        currentItem.color,
        currentItem.color
    )

    return { sizes, colors }
}

async function buildUiItems(lineItems, savedItems = []) {
    const rows = Array.isArray(savedItems) && savedItems.length
        ? buildRowsFromSavedItems(savedItems)
        : buildRows(lineItems)

    return Promise.all(rows.map(async row => {
        const optionSets = await getProductOptionSets(row.productId, row)
        const matchingColor = (optionSets.colors || []).find(option =>
            (option?.value || '').toString().toLowerCase() === (row.color || '').toString().toLowerCase() ||
            (option?.label || '').toString().toLowerCase() === (row.color || '').toString().toLowerCase()
        )
        const inferredColorHex = row.colorHex || matchingColor?.color || ((row.color || '').startsWith('#') ? row.color : '')

        return {
            ...row,
            colorHex: inferredColorHex,
            image: matchingColor?.image || row.image || '',
            optionSets
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

function isEditingAllowed(order, isAdminMode) {
    if (isAdminMode) return false

    const status = (order?.orderStatus || '').toString().toLowerCase()
    return status === '' || status === 'pending' || status === 'pending (24h)'
}

async function orderToUiState(order, { isAdminMode = false } = {}) {
    const firstName = order?.recipientInfo?.contactDetails?.firstName || ''
    const lastName = order?.recipientInfo?.contactDetails?.lastName || ''
    const items = await buildUiItems(order?.lineItems || [], order?.newLineItems || [])

    return {
        order: {
            id: order?._id || '',
            number: order?.number || '',
            status: order?.orderStatus || 'Pending',
            createdDate: order?._createdDate || order?._dateCreated || ''
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
            editingAllowed: isEditingAllowed(order, isAdminMode)
        }
    }
}

async function pushCurrentState() {
    if (!currentOrder) {
        log('pushCurrentState skipped — no currentOrder')
        return
    }
    const state = await orderToUiState(currentOrder, { isAdminMode: currentIsAdminMode })
    log('pushCurrentState', {
        orderNumber: state.order?.number,
        status: state.order?.status,
        itemCount: state.items?.length,
        editingAllowed: state.permissions?.editingAllowed,
        isAdminMode: state.permissions?.isAdminMode
    })
    postToUi({
        type: 'TW_SET_STATE',
        state
    })
}

async function handleAdminMode() {
    log('handleAdminMode start', { orderId: currentOrderId, loggedIn: authentication.loggedIn() })

    const isLoggedIn = authentication.loggedIn()

    if (!isLoggedIn) {
        try {
            log('awaiting admin login prompt')
            await authentication.promptLogin({
                mode: 'login',
                modal: true
            })
            log('admin login prompt resolved', { loggedIn: authentication.loggedIn() })
        } catch (error) {
            console.error(LOG_NS, 'Admin login cancelled or failed:', error)
            return
        }
    }

    const roleCheck = await checkMemberRoles()
    log('checkMemberRoles', {
        ok: roleCheck?.ok,
        isAdmin: roleCheck?.isAdmin,
        isContributor: roleCheck?.isContributor,
        isOwner: roleCheck?.isOwner
    })

    if (!roleCheck?.ok || (!roleCheck.isAdmin && !roleCheck.isContributor && !roleCheck.isOwner)) {
        log('admin access denied — role check failed')
        postToUi({
            type: 'TW_AUTH_RESULT',
            ok: false,
            message: 'Access denied: Admin permissions required'
        })
        return
    }

    const result = await getOrderForAdmin(currentOrderId)
    log('getOrderForAdmin', { ok: result?.ok, hasOrder: !!result?.order })

    if (!result?.ok) {
        postToUi({
            type: 'TW_AUTH_RESULT',
            ok: false,
            message: 'Order not found'
        })
        return
    }

    currentOrder = result.order
    log('admin order loaded', { number: currentOrder?.number, status: currentOrder?.orderStatus })
    await pushCurrentState()
}

function buildUpdatePayload(changes) {
    const payload = changes.map(change => ({
        itemId: (change.itemId || '').toString() || uid(),
        rowKey: (change.rowKey || '').toString(),
        productId: (change.productId || '').toString(),
        productName: (change.productName || '').toString(),
        size: (change.size || '').toString(),
        color: (change.color || '').toString(),
        colorHex: (change.colorHex || '').toString(),
        nameNumber: (change.nameNumber || '').toString(),
        image: (change.image || '').toString()
    }))
    log('buildUpdatePayload', {
        rowCount: payload.length,
        rowKeys: payload.map(p => p.rowKey).slice(0, 15)
    })
    return payload
}

$w.onReady(function () {
    uiHtml = $w(UI_HTML_ID)
    if (!uiHtml) {
        log('onReady: HTML component not found —', UI_HTML_ID)
        return
    }

    const path = norm(wixLocation.path)
    currentOrderId = path.length ? path[path.length - 1] : ''
    currentIsAdminMode = wixLocation.query.admin === 'true'

    log('onReady', {
        iframeSrc: IFRAME_URL,
        orderIdFromPath: currentOrderId,
        adminQuery: currentIsAdminMode,
        path
    })

    uiHtml.src = IFRAME_URL

    uiHtml.onMessage(async event => {
        const data = event?.data || {}
        if (!data?.type) {
            log('← iframe message ignored (no type)', typeof event?.data)
            return
        }

        log('← iframe', summarizeInboundData(data))

        if (data.type === 'TW_READY') {
            log('TW_READY: sending TW_INIT', { orderId: currentOrderId, isAdminMode: currentIsAdminMode })
            postToUi({
                type: 'TW_INIT',
                orderId: currentOrderId,
                isAdminMode: currentIsAdminMode
            })

            if (currentIsAdminMode) {
                await handleAdminMode()
            }
            return
        }

        if (data.type === 'TW_REQUEST_STATE') {
            log('TW_REQUEST_STATE', { hasCurrentOrder: !!currentOrder })
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
                const email = (data.email || '').toString().trim()
                const orderNumber = (data.orderNumber || '').toString().trim()

                log('TW_AUTH_SUBMIT: validating', {
                    orderId: currentOrderId,
                    email: maskEmail(email),
                    orderNumber: maskOrderRef(orderNumber)
                })

                if (!currentOrderId || !email || !orderNumber) {
                    log('TW_AUTH_SUBMIT: rejected — missing orderId, email, or orderNumber')
                    postToUi({
                        type: 'TW_AUTH_RESULT',
                        ok: false,
                        message: 'Missing order number or email'
                    })
                    return
                }

                const result = await verifyOrderAndStatus(currentOrderId, email, orderNumber)
                log('verifyOrderAndStatus result', { ok: result?.ok, hasOrder: !!result?.order })

                if (!result?.ok) {
                    log('TW_AUTH_SUBMIT: verify failed (ok=false)')
                    postToUi({
                        type: 'TW_AUTH_RESULT',
                        ok: false,
                        message: 'Access denied for the provided details'
                    })
                    return
                }

                currentOrder = result.order
                log('TW_AUTH_SUBMIT: success', { orderNumber: currentOrder?.number, status: currentOrder?.orderStatus })
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
                    log('TW_SAVE_SUBMIT: rejected — no orderId')
                    postToUi({
                        type: 'TW_SAVE_RESULT',
                        ok: false,
                        message: 'Order ID not found'
                    })
                    return
                }

                if (!changes.length) {
                    log('TW_SAVE_SUBMIT: rejected — empty changes')
                    postToUi({
                        type: 'TW_SAVE_RESULT',
                        ok: false,
                        message: 'No changes to save'
                    })
                    return
                }

                const payload = buildUpdatePayload(changes)
                const result = await updateOrderLineItems(currentOrderId, payload)
                log('updateOrderLineItems result', { ok: result?.ok, newStatus: result?.newStatus, message: result?.message })

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
                log('TW_SAVE_SUBMIT: completed — state updated + TW_LOCK_EDITING sent')
            } catch (error) {
                console.error(LOG_NS, 'updateOrderLineItems failed:', error)
                postToUi({
                    type: 'TW_SAVE_RESULT',
                    ok: false,
                    message: 'Error saving changes'
                })
            }
        }
    })
})