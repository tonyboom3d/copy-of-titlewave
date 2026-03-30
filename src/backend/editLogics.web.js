import { Permissions, webMethod } from 'wix-web-module'
import { orders } from 'wix-ecom-backend'
import wixData from 'wix-data'
import { currentMember } from 'wix-members-backend'

const s = x => (x || '').toString().trim().toLowerCase()

export const verifyOrderAndStatus = webMethod(
    Permissions.Anyone,
    async (orderId, email, orderNumber) => {
        try {
            // orderId can be either:
            // - Wix order _id (orders.getOrder expects this)
            // - ordersStatus CMS record _id (dynamic page uses record id in URL)
            let resolvedOrderId = orderId

            let o = null
            try {
                o = await orders.getOrder(resolvedOrderId)
            } catch (e) {
                // Try resolving from CMS record id → actual orderId
                const rec = await wixData.query('ordersStatus')
                    .eq('_id', orderId)
                    .limit(1)
                    .find({ suppressAuth: true, suppressHooks: true })

                const item = rec.items[0] || null
                const maybeOrderId = item?.orderId || ''

                if (!maybeOrderId) {
                    console.error('verifyOrderAndStatus resolve failed:', { orderId })
                    return { ok: false, code: 'ORDER_NOT_FOUND' }
                }

                resolvedOrderId = maybeOrderId
                o = await orders.getOrder(resolvedOrderId)
            }
            const be = s(o?.buyerInfo?.email)
            const ue = s(email)
            const bn = s(o?.number)
            const un = s(orderNumber)
            if (!be || !bn) return { ok: false, code: 'MISSING_ORDER_INFO' }
            if (be !== ue || bn !== un) return { ok: false, code: 'ORDER_MISMATCH' }

            // ✅ שלוף את הסטטוס מ-CMS
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
                // ✅ הוסף את השדות החדשים
                newLineItems: statusRecord?.newLineItems || [],
                orderStatus: statusRecord?.orderStatus || 'Pending'
            }

            return { ok: true, order, status: statusRecord }
        } catch (err) {
            console.error('verifyOrderAndStatus error:', err)
            return { ok: false, code: 'ORDER_FETCH_ERROR' }
        }
    }
)

export const getOrderForAdmin = webMethod(Permissions.Anyone, async (orderId) => {
    try {
        const roles = await currentMember.getRoles()
        const isAdmin = roles.some(role => role.title === 'Admin')

        if (!isAdmin) {
            return { ok: false, code: 'UNAUTHORIZED' }
        }

        // orderId can be either Wix order _id or ordersStatus record _id (dynamic URL)
        let resolvedOrderId = orderId
        let o = null
        try {
            o = await orders.getOrder(resolvedOrderId)
        } catch (e) {
            const rec = await wixData.query('ordersStatus')
                .eq('_id', orderId)
                .limit(1)
                .find({ suppressAuth: true, suppressHooks: true })

            const item = rec.items[0] || null
            const maybeOrderId = item?.orderId || ''
            if (!maybeOrderId) return { ok: false, code: 'ORDER_NOT_FOUND' }

            resolvedOrderId = maybeOrderId
            o = await orders.getOrder(resolvedOrderId)
        }

        if (!o) {
            return { ok: false, code: 'ORDER_NOT_FOUND' }
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
            orderStatus: statusRecord?.orderStatus || 'Pending'
        }

        return { ok: true, order, status: statusRecord }
    } catch (err) {
        console.error('getOrderForAdmin error:', err)
        return { ok: false, code: 'ORDER_FETCH_ERROR' }
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
        const r = await wixData.query('Stores/Products')
            .eq('_id', catalogItemId)
            .fields('productOptions')
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })
        if (!r.items.length) return { ok: false, code: 'PRODUCT_NOT_FOUND' }
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
        return { ok: true, productOptions: out }
    }
)