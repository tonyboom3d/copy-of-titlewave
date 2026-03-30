import wixData from 'wix-data'
import { Permissions, webMethod } from 'wix-web-module'

export const updateOrderLineItems = webMethod(Permissions.Anyone, async (orderId, updatedItems) => {
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

        const orderStatus = (existingOrder.orderStatus || '').toString()
        if (!orderStatus.toLowerCase().includes('pending')) {
            return {
                ok: false,
                code: 'ORDER_NOT_PENDING',
                message: `Cannot update order. Current status: ${orderStatus}`,
                currentStatus: orderStatus
            }
        }

        const updatedOrder = { ...existingOrder, newLineItems: updatedItems, orderStatus: ['Waiting for Approval'], }

        const updateResult = await wixData.update('ordersStatus', updatedOrder, { suppressAuth: true, suppressHooks: true })

        return {
            ok: true,
            message: 'Order updated successfully',
            orderId: updateResult.orderId,
            newStatus: updateResult.orderStatus
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