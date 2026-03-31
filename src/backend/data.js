import { fetch } from 'wix-fetch'

const GOOGLE_SHEETS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbySeTJtqpD-4PlLwpJ4OZztD1VCOOThT3UnBWxvkv8EAz5HxN2YgGOfkLwjneLQG8zIrA/exec'
const LOG_NS = '📤 [TW Google Sheets Sync]'

function log(message, meta = {}) {
    console.log(LOG_NS, message, meta)
}

function normalizeStatus(statusValue) {
    if (Array.isArray(statusValue)) {
        const first = statusValue.find(Boolean)
        return first ? String(first).trim() : ''
    }
    return String(statusValue || '').trim()
}

function buildItemPayloads(item) {
    const orderStatus = normalizeStatus(item?.orderStatus)
    const comment = item?.backOfficeMsg || ''
    const primaryItems = Array.isArray(item?.newLineItems) && item.newLineItems.length
        ? item.newLineItems
        : (Array.isArray(item?.lineItems) ? item.lineItems : [])

    const itemPayloads = primaryItems
        .filter(entry => String(entry?.itemId || '').trim())
        .map(entry => ({
            action: 'updateOrder',
            sheetTitle: item?.sheetName || 'Sheet1',
            orderId: item?.orderId || '',
            orderNumber: item?.orderNumber || '',
            itemId: String(entry?.itemId || '').trim(),
            status: normalizeStatus(entry?.status) || orderStatus,
            comment
        }))

    if (itemPayloads.length) return itemPayloads

    return [{
        action: 'updateOrder',
        sheetTitle: item?.sheetName || 'Sheet1',
        orderId: item?.orderId || '',
        orderNumber: item?.orderNumber || '',
        status: orderStatus,
        comment
    }]
}

export async function ordersStatus_afterUpdate(item, context) {
    const payloads = buildItemPayloads(item)
    log('ordersStatus_afterUpdate:start', {
        orderId: item?.orderId || '',
        orderNumber: item?.orderNumber || '',
        sheetName: item?.sheetName || 'Sheet1',
        payloadCount: payloads.length,
        orderStatus: normalizeStatus(item?.orderStatus)
    })

    try {
        await Promise.all(payloads.map(async payload => {
            log('sending payload to Google Sheets', {
                orderId: payload.orderId || '',
                orderNumber: payload.orderNumber || '',
                itemId: payload.itemId || '',
                status: payload.status || '',
                sheetTitle: payload.sheetTitle || '',
                endpoint: GOOGLE_SHEETS_ENDPOINT
            })

            const response = await fetch(GOOGLE_SHEETS_ENDPOINT, {
                method: 'post',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            })

            const responseText = await response.text().catch(() => '')
            log('Google Sheets response received', {
                orderId: payload.orderId || '',
                orderNumber: payload.orderNumber || '',
                itemId: payload.itemId || '',
                status: payload.status || '',
                httpStatus: response?.status || 0,
                ok: !!response?.ok,
                bodyPreview: String(responseText || '').slice(0, 300)
            })
        }))
    } catch (err) {
        console.error(LOG_NS, 'request failed', {
            orderId: item?.orderId || '',
            orderNumber: item?.orderNumber || '',
            message: err?.message || String(err || '')
        })
    }

    return item
}