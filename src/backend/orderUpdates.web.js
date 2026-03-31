import wixData from 'wix-data'
import { orders } from 'wix-ecom-backend'
import { Permissions, webMethod } from 'wix-web-module'

const EDIT_WINDOW_MS = 24 * 3600 * 1000
const WAITING_FOR_APPROVAL_TAGS = ['Waiting for Approval']
const PENDING_TAGS = ['Pending (24h)', 'Pending', 'Open for edits']

function normalizeStatus(statusValue) {
    if (Array.isArray(statusValue)) {
        const first = statusValue.find(Boolean)
        return first ? String(first).trim() : ''
    }
    return String(statusValue || '').trim()
}

function isWithin24Hours(dateValue) {
    if (!dateValue) return false
    const createdAtMs = new Date(dateValue).getTime()
    if (Number.isNaN(createdAtMs)) return false
    return (Date.now() - createdAtMs) <= EDIT_WINDOW_MS
}

export const updateOrderLineItems = webMethod(Permissions.Anyone, async (orderId, updatedItems, options = {}) => {
    try {
        const orderQuery = await wixData.query('ordersStatus')
            .eq('orderId', orderId)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })

        if (!orderQuery.items.length) {
            return {
                ok: false,
                code: 'ORDER_NOT_FOUND',
                message: 'Order not found'
            }
        }

        const existingOrder = orderQuery.items[0]
        let orderCreatedDate = existingOrder.orderCreatedDate || existingOrder.createdDate || existingOrder._createdDate || ''

        if (!isWithin24Hours(orderCreatedDate) && existingOrder.orderId) {
            try {
                const wixOrder = await orders.getOrder(existingOrder.orderId)
                orderCreatedDate = wixOrder?._createdDate || wixOrder?._dateCreated || orderCreatedDate
            } catch (error) {
                console.error('Error resolving Wix order created date:', error)
            }
        }

        const bypassTimeWindow = !!options?.bypassTimeWindow

        if (!bypassTimeWindow && !isWithin24Hours(orderCreatedDate)) {
            return {
                ok: false,
                code: 'EDIT_WINDOW_EXPIRED',
                message: 'The 24-hour editing window has expired'
            }
        }

        const orderStatus = normalizeStatus(existingOrder.orderStatus)
        const orderStatusLower = orderStatus.toLowerCase()

        // Treat missing/empty status as "open for edits" to avoid blocking legitimate saves
        const isEditableStatus =
            !orderStatusLower ||
            PENDING_TAGS.some(tag => orderStatusLower.includes(String(tag).toLowerCase())) ||
            orderStatusLower.includes('pending')

        if (!isEditableStatus) {
            return {
                ok: false,
                code: 'ORDER_NOT_PENDING',
                message: `Cannot update order. Current status: ${orderStatus}`,
                currentStatus: orderStatus
            }
        }

        const normalizedUpdatedItems = (Array.isArray(updatedItems) ? updatedItems : []).map(item => ({
            ...(item || {}),
            status: WAITING_FOR_APPROVAL_TAGS[0]
        }))

        const currentSnapshots = Array.isArray(existingOrder.lineItems) ? existingOrder.lineItems.slice() : []
        const nextSnapshots = currentSnapshots.map(snapshot => {
            const snapshotKey = String(snapshot?.itemId || '')
            const matching = normalizedUpdatedItems.find(item => String(item?.itemId || '') === snapshotKey)
            if (!matching) return snapshot
            return {
                ...(snapshot || {}),
                status: WAITING_FOR_APPROVAL_TAGS[0]
            }
        })

        const updatedOrder = {
            ...existingOrder,
            newLineItems: normalizedUpdatedItems,
            lineItems: nextSnapshots,
            orderStatus: WAITING_FOR_APPROVAL_TAGS
        }

        const updateResult = await wixData.update('ordersStatus', updatedOrder, { suppressAuth: true, suppressHooks: false })

        return {
            ok: true,
            message: 'Order updated successfully',
            orderId: updateResult.orderId,
            newStatus: normalizeStatus(updateResult.orderStatus) || WAITING_FOR_APPROVAL_TAGS[0]
        }

    } catch (error) {
        console.error('Error updating order:', error)
        return {
            ok: false,
            code: 'UPDATE_FAILED',
            message: error.message || 'Failed to update order'
        }
    }
})