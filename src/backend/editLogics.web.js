import { Permissions, webMethod } from 'wix-web-module'
import { orders } from 'wix-ecom-backend'
import wixData from 'wix-data'
import { currentMember } from 'wix-members-backend'

const s = x => (x || '').toString().trim().toLowerCase()
const LOG_NS = '[TW backend]'
const ADMIN_ACCESS_CODE = '13261326'

function log(...args) {
    console.log(LOG_NS, ...args)
}

function maskEmail(email) {
    const value = (email || '').toString().trim()
    if (!value) return '(empty)'
    const at = value.indexOf('@')
    if (at < 1) return `${value.slice(0, 2)}...`
    return `${value.slice(0, 2)}...@${value.slice(at + 1)}`
}

function maskOrderRef(orderNumber) {
    const value = (orderNumber || '').toString().trim()
    if (!value) return '(empty)'
    if (value.length <= 4) return '...' + value.slice(-2)
    return `...${value.slice(-4)}`
}

function maskAccessCode(code) {
    const value = (code || '').toString().trim()
    if (!value) return '(empty)'
    return `len:${value.length}`
}

function hasValidAdminAccessCode(code) {
    return (code || '').toString().trim() === ADMIN_ACCESS_CODE
}

export const verifyOrderAndStatus = webMethod(
    Permissions.Anyone,
    async (orderId, email, orderNumber) => {
        try {
            log('verifyOrderAndStatus:start', {
                inputOrderId: orderId,
                email: maskEmail(email),
                orderNumber: maskOrderRef(orderNumber)
            })

            // orderId can be either:
            // - Wix order _id (orders.getOrder expects this)
            // - ordersStatus CMS record _id (dynamic page uses record id in URL)
            let resolvedOrderId = orderId

            let o = null
            try {
                log('verifyOrderAndStatus:trying direct orders.getOrder', { orderId: resolvedOrderId })
                o = await orders.getOrder(resolvedOrderId)
                log('verifyOrderAndStatus:direct order fetch ok', { orderId: resolvedOrderId, orderNumber: o?.number })
            } catch (e) {
                log('verifyOrderAndStatus:direct order fetch failed, trying ordersStatus resolve', {
                    inputOrderId: orderId,
                    errorMessage: e?.message || ''
                })

                // Try resolving from CMS record id → actual orderId
                const rec = await wixData.query('ordersStatus')
                    .eq('_id', orderId)
                    .limit(1)
                    .find({ suppressAuth: true, suppressHooks: true })

                const item = rec.items[0] || null
                const maybeOrderId = item?.orderId || ''
                log('verifyOrderAndStatus:ordersStatus resolve result', {
                    foundRecord: !!item,
                    resolvedOrderId: maybeOrderId || '(empty)'
                })

                if (!maybeOrderId) {
                    console.error(LOG_NS, 'verifyOrderAndStatus resolve failed:', { orderId })
                    return { ok: false, code: 'ORDER_NOT_FOUND' }
                }

                resolvedOrderId = maybeOrderId
                log('verifyOrderAndStatus:trying resolved orders.getOrder', { resolvedOrderId })
                o = await orders.getOrder(resolvedOrderId)
                log('verifyOrderAndStatus:resolved order fetch ok', { resolvedOrderId, orderNumber: o?.number })
            }
            const be = s(o?.buyerInfo?.email)
            const ue = s(email)
            const bn = s(o?.number)
            const un = s(orderNumber)
            log('verifyOrderAndStatus:compare', {
                resolvedOrderId,
                buyerEmail: maskEmail(be),
                userEmail: maskEmail(ue),
                buyerOrderNumber: maskOrderRef(bn),
                userOrderNumber: maskOrderRef(un)
            })
            if (!be || !bn) {
                log('verifyOrderAndStatus:missing order info', { hasBuyerEmail: !!be, hasOrderNumber: !!bn })
                return { ok: false, code: 'MISSING_ORDER_INFO' }
            }
            if (be !== ue || bn !== un) {
                log('verifyOrderAndStatus:mismatch', {
                    emailMatches: be === ue,
                    orderNumberMatches: bn === un
                })
                return { ok: false, code: 'ORDER_MISMATCH' }
            }

            // ✅ שלוף את הסטטוס מ-CMS
            const q = await wixData.query('ordersStatus')
                .eq('orderId', resolvedOrderId)
                .limit(1)
                .find({ suppressAuth: true, suppressHooks: true })

            const statusRecord = q.items[0] || null
            log('verifyOrderAndStatus:status lookup', {
                resolvedOrderId,
                foundStatusRecord: !!statusRecord,
                orderStatus: statusRecord?.orderStatus || 'Pending'
            })

            const order = {
                _id: o._id,
                number: o.number,
                lineItems: o.lineItems || [],
                buyerInfo: o.buyerInfo || {},
                recipientInfo: o.recipientInfo || {},
                _createdDate: o._createdDate,
                // ✅ הוסף את השדות החדשים
                newLineItems: statusRecord?.newLineItems || [],
                orderStatus: statusRecord?.orderStatus || 'Pending',
                msgForClient: statusRecord?.msgForClient || [],
                backOfficeMsg: statusRecord?.backOfficeMsg || '',
                lineItemsSnapshot: statusRecord?.lineItems || []
            }

            log('verifyOrderAndStatus:success', {
                resolvedOrderId,
                orderNumber: order.number,
                lineItemCount: Array.isArray(order.lineItems) ? order.lineItems.length : 0
            })
            return { ok: true, order, status: statusRecord }
        } catch (err) {
            console.error(LOG_NS, 'verifyOrderAndStatus error:', err)
            return { ok: false, code: 'ORDER_FETCH_ERROR' }
        }
    }
)

export const getOrderForAdmin = webMethod(Permissions.Anyone, async (orderId) => {
    try {
        log('getOrderForAdmin:start', { inputOrderId: orderId })
        const roles = await currentMember.getRoles()
        const isAdmin = roles.some(role => role.title === 'Admin')
        log('getOrderForAdmin:roles', {
            roleTitles: roles.map(role => role.title),
            isAdmin
        })

        if (!isAdmin) {
            log('getOrderForAdmin:unauthorized')
            return { ok: false, code: 'UNAUTHORIZED' }
        }

        // orderId can be either Wix order _id or ordersStatus record _id (dynamic URL)
        let resolvedOrderId = orderId
        let o = null
        try {
            log('getOrderForAdmin:trying direct orders.getOrder', { orderId: resolvedOrderId })
            o = await orders.getOrder(resolvedOrderId)
            log('getOrderForAdmin:direct order fetch ok', { orderId: resolvedOrderId, orderNumber: o?.number })
        } catch (e) {
            log('getOrderForAdmin:direct fetch failed, trying ordersStatus resolve', {
                inputOrderId: orderId,
                errorMessage: e?.message || ''
            })
            const rec = await wixData.query('ordersStatus')
                .eq('_id', orderId)
                .limit(1)
                .find({ suppressAuth: true, suppressHooks: true })

            const item = rec.items[0] || null
            const maybeOrderId = item?.orderId || ''
            log('getOrderForAdmin:ordersStatus resolve result', {
                foundRecord: !!item,
                resolvedOrderId: maybeOrderId || '(empty)'
            })
            if (!maybeOrderId) return { ok: false, code: 'ORDER_NOT_FOUND' }

            resolvedOrderId = maybeOrderId
            log('getOrderForAdmin:trying resolved orders.getOrder', { resolvedOrderId })
            o = await orders.getOrder(resolvedOrderId)
            log('getOrderForAdmin:resolved order fetch ok', { resolvedOrderId, orderNumber: o?.number })
        }

        if (!o) {
            log('getOrderForAdmin:order not found after resolution', { resolvedOrderId })
            return { ok: false, code: 'ORDER_NOT_FOUND' }
        }

        const q = await wixData.query('ordersStatus')
            .eq('orderId', resolvedOrderId)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })

        const statusRecord = q.items[0] || null
        log('getOrderForAdmin:status lookup', {
            resolvedOrderId,
            foundStatusRecord: !!statusRecord,
            orderStatus: statusRecord?.orderStatus || 'Pending'
        })

        const order = {
            _id: o._id,
            number: o.number,
            lineItems: o.lineItems || [],
            buyerInfo: o.buyerInfo || {},
            recipientInfo: o.recipientInfo || {},
            _createdDate: o._createdDate,
            newLineItems: statusRecord?.newLineItems || [],
            orderStatus: statusRecord?.orderStatus || 'Pending',
            msgForClient: statusRecord?.msgForClient || [],
            backOfficeMsg: statusRecord?.backOfficeMsg || '',
            lineItemsSnapshot: statusRecord?.lineItems || []
        }

        log('getOrderForAdmin:success', {
            resolvedOrderId,
            orderNumber: order.number,
            lineItemCount: Array.isArray(order.lineItems) ? order.lineItems.length : 0
        })
        return { ok: true, order, status: statusRecord }
    } catch (err) {
        console.error(LOG_NS, 'getOrderForAdmin error:', err)
        return { ok: false, code: 'ORDER_FETCH_ERROR' }
    }
})

export const getOrderForAdminCode = webMethod(Permissions.Anyone, async (orderId, accessCode) => {
    try {
        log('getOrderForAdminCode:start', {
            inputOrderId: orderId,
            accessCode: maskAccessCode(accessCode)
        })

        if (!hasValidAdminAccessCode(accessCode)) {
            log('getOrderForAdminCode:unauthorized')
            return { ok: false, code: 'UNAUTHORIZED', message: 'Invalid admin code' }
        }

        let resolvedOrderId = orderId
        let o = null
        try {
            log('getOrderForAdminCode:trying direct orders.getOrder', { orderId: resolvedOrderId })
            o = await orders.getOrder(resolvedOrderId)
            log('getOrderForAdminCode:direct order fetch ok', { orderId: resolvedOrderId, orderNumber: o?.number })
        } catch (e) {
            log('getOrderForAdminCode:direct fetch failed, trying ordersStatus resolve', {
                inputOrderId: orderId,
                errorMessage: e?.message || ''
            })
            const rec = await wixData.query('ordersStatus')
                .eq('_id', orderId)
                .limit(1)
                .find({ suppressAuth: true, suppressHooks: true })

            const item = rec.items[0] || null
            const maybeOrderId = item?.orderId || ''
            log('getOrderForAdminCode:ordersStatus resolve result', {
                foundRecord: !!item,
                resolvedOrderId: maybeOrderId || '(empty)'
            })
            if (!maybeOrderId) return { ok: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' }

            resolvedOrderId = maybeOrderId
            log('getOrderForAdminCode:trying resolved orders.getOrder', { resolvedOrderId })
            o = await orders.getOrder(resolvedOrderId)
            log('getOrderForAdminCode:resolved order fetch ok', { resolvedOrderId, orderNumber: o?.number })
        }

        if (!o) {
            log('getOrderForAdminCode:order not found after resolution', { resolvedOrderId })
            return { ok: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' }
        }

        const q = await wixData.query('ordersStatus')
            .eq('orderId', resolvedOrderId)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })

        const statusRecord = q.items[0] || null
        const order = {
            _id: o._id,
            number: o.number,
            lineItems: o.lineItems || [],
            buyerInfo: o.buyerInfo || {},
            recipientInfo: o.recipientInfo || {},
            _createdDate: o._createdDate,
            newLineItems: statusRecord?.newLineItems || [],
            orderStatus: statusRecord?.orderStatus || 'Pending',
            msgForClient: statusRecord?.msgForClient || [],
            backOfficeMsg: statusRecord?.backOfficeMsg || '',
            lineItemsSnapshot: statusRecord?.lineItems || []
        }

        log('getOrderForAdminCode:success', {
            resolvedOrderId,
            orderNumber: order.number,
            lineItemCount: Array.isArray(order.lineItems) ? order.lineItems.length : 0
        })
        return { ok: true, order, status: statusRecord }
    } catch (err) {
        console.error(LOG_NS, 'getOrderForAdminCode error:', err)
        return { ok: false, code: 'ORDER_FETCH_ERROR', message: 'Order not found' }
    }
})

export const applyAdminDecisions = webMethod(Permissions.Anyone, async (orderId, decisions = [], nextOrderStatus = '', accessCode = '') => {
    try {
        log('applyAdminDecisions:start', { orderId, decisionCount: Array.isArray(decisions) ? decisions.length : 0 })

        const roles = await currentMember.getRoles().catch(() => [])
        const isAdmin = Array.isArray(roles) && roles.some(role => role.title === 'Admin')
        const hasCode = hasValidAdminAccessCode(accessCode)
        if (!isAdmin && !hasCode) return { ok: false, code: 'UNAUTHORIZED', message: 'Admin authorization expired. Please log in again.' }

        const orderIdStr = String(orderId || '').trim()
        if (!orderIdStr) return { ok: false, code: 'MISSING_ORDER_ID', message: 'Order ID is missing.' }

        const q = await wixData.query('ordersStatus')
            .eq('orderId', orderIdStr)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })
        const rec = q.items[0] || null
        if (!rec) return { ok: false, code: 'ORDER_NOT_FOUND', message: 'Order status record was not found.' }

        const decs = Array.isArray(decisions) ? decisions : []
        const byKey = new Map(decs.map(d => [String(d?.rowKey || d?.itemId || ''), String(d?.status || '').trim()]))

        const items = Array.isArray(rec.newLineItems) ? rec.newLineItems.slice() : []
        const nextItems = items.map(it => {
            const rk = String(it?.rowKey || '')
            const ik = String(it?.itemId || '')
            const k = rk || ik
            const st = byKey.get(k)
            if (!st) return it
            return { ...(it || {}), status: st }
        })
        const baseSnapshots = Array.isArray(rec.lineItems) ? rec.lineItems.slice() : []
        const nextSnapshots = baseSnapshots.map(it => {
            const ik = String(it?.itemId || '')
            const st = byKey.get(ik)
            if (!st) return it
            return { ...(it || {}), status: st }
        })

        function norm(v) {
            const s = String(v || '').trim()
            return s ? s : ''
        }

        let finalOrderStatus = norm(nextOrderStatus)
        if (!finalOrderStatus) {
            const statuses = nextItems.map(x => String(x?.status || '').trim()).filter(Boolean)
            if (statuses.length && statuses.every(s => s.toLowerCase() === 'approved')) finalOrderStatus = 'Approved'
            else if (statuses.some(s => s.toLowerCase() === 'rejected')) finalOrderStatus = 'Rejected'
            else finalOrderStatus = 'Waiting for Approval'
        }

        const updated = {
            ...rec,
            newLineItems: nextItems,
            lineItems: nextSnapshots,
            orderStatus: finalOrderStatus ? [finalOrderStatus] : rec.orderStatus
        }

        await wixData.update('ordersStatus', updated, { suppressAuth: true, suppressHooks: false })
        return { ok: true, orderId: orderIdStr, orderStatus: finalOrderStatus }
    } catch (err) {
        console.error(LOG_NS, 'applyAdminDecisions error:', err)
        return { ok: false, code: 'UPDATE_FAILED', message: err?.message || 'Could not apply admin decisions.' }
    }
})

export const appendOrderMessage = webMethod(Permissions.Anyone, async (orderId, text = '', senderName = '', senderRole = '') => {
    try {
        const orderIdStr = String(orderId || '').trim()
        const msg = String(text || '').trim()
        if (!orderIdStr) return { ok: false, code: 'MISSING_ORDER_ID' }
        if (!msg) return { ok: false, code: 'EMPTY_MESSAGE' }

        const q = await wixData.query('ordersStatus')
            .eq('orderId', orderIdStr)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })
        const rec = q.items[0] || null
        if (!rec) return { ok: false, code: 'ORDER_NOT_FOUND' }

        const thread = Array.isArray(rec.msgForClient) ? rec.msgForClient.slice() : []
        const normalizedRole = String(senderRole || '').trim() || 'user'
        if (normalizedRole !== 'admin') {
            let consecutiveClientMessages = 0
            for (let i = thread.length - 1; i >= 0; i--) {
                const role = String(thread[i]?.role || '').trim().toLowerCase()
                if (role === 'admin') break
                if (role === 'client' || role === 'user' || role === 'customer') {
                    consecutiveClientMessages += 1
                    continue
                }
                break
            }
            if (consecutiveClientMessages >= 2) {
                return {
                    ok: false,
                    code: 'CLIENT_MESSAGE_LIMIT',
                    message: 'Please wait for Customer Service to reply before sending another message.'
                }
            }
        }

        const displayName = normalizedRole === 'admin'
            ? 'Customer Service'
            : (String(senderName || '').trim() || 'Customer')
        thread.push({
            name: String(senderName || '').trim() || 'User',
            displayName,
            role: normalizedRole,
            avatarKind: normalizedRole === 'admin' ? 'customer-service' : 'customer',
            ts: new Date().toISOString(),
            text: msg
        })

        const updated = { ...rec, msgForClient: thread }
        await wixData.update('ordersStatus', updated, { suppressAuth: true, suppressHooks: true })
        return { ok: true, msgForClient: thread }
    } catch (err) {
        console.error(LOG_NS, 'appendOrderMessage error:', err)
        return { ok: false, code: 'UPDATE_FAILED' }
    }
})

const toStatic = url => {
    if (!url || typeof url !== 'string') return ''
    if (!url.startsWith('wix:image://')) return url
    const base = url.split('#')[0]
    const after = base.startsWith('wix:image://v1/') ? base.slice('wix:image://v1/'.length) : base.replace('wix:image://', '')
    const mediaId = after.split('/')[0]
    return `https://static.wixstatic.com/media/${mediaId}`
}

export const getFilteredProductOptions = webMethod(
    Permissions.Anyone,
    async (catalogItemId) => {
        log('getFilteredProductOptions:start', { catalogItemId })
        const r = await wixData.query('Stores/Products')
            .eq('_id', catalogItemId)
            .fields('productOptions')
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })
        if (!r.items.length) {
            log('getFilteredProductOptions:product not found', { catalogItemId })
            return { ok: false, code: 'PRODUCT_NOT_FOUND' }
        }
        const po = r.items[0].productOptions || {}
        const out = {}
        Object.keys(po).forEach(k => {
            const o = po[k] || {}
            const choices = (o.choices || [])
                .filter(c => c?.visible !== false && c?.inStock !== false)
                .map(c => ({
                    value: c?.value || '',
                    description: c?.description || '',
                    color: c?.color || (c?.value && /^#/.test(c.value) ? c.value : ''), // ✅ שמור HEX
                    mainMedia: toStatic(c?.mainMedia || '') // ✅ כבר static URL
                }))
            out[k] = { name: o.name || k, optionType: o.optionType || 'drop_down', choices }
        })
        log('getFilteredProductOptions:success', {
            catalogItemId,
            optionKeys: Object.keys(out),
            optionCount: Object.keys(out).length
        })
        return { ok: true, productOptions: out }
    }
)