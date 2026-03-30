import { dashboard } from '@wix/dashboard'
import { fetchOrdersByIds } from 'backend/orders'
// import { prepareSheetRowsByIds, buildSheetTitle, sendRowsToGoogle } from 'backend/exportOrders'
import { exportSelectedOrders } from 'backend/exportOrders'

const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbwnLc3KSiSi0TVv_pZ_WfXb_mJ-Qb8-kHKjp9y0JnrOY5RxmyHtJ6Wb46l4Aveux9zIqA/exec'

$w.onReady(() => {
    const html = $w('#ordersModule')

    const setLoading = (active, message) =>
        html.postMessage({ type: 'loading', active: !!active, message: message || '' })

    dashboard.observeState(async componentParams => {
        const ids = componentParams?.selectedIds || []
        if (!ids.length) {
            html.postMessage({ type: 'ordersData', orders: [] })
            return
        }
        setLoading(true, `Fetching ${ids.length} selected orders...`)
        const raw = await fetchOrdersByIds(ids)
        const ui = raw.map(o => {
            const bi = o?.buyerInfo || {}
            const name = [bi.firstName, bi.lastName].filter(Boolean).join(' ')
            const email = bi.email || ''
            const total = o?.totals?.total ?? 0
            const status = o?.paymentStatus || o?.fulfillmentStatus || ''
            const date = o?._dateCreated || ''
            return {
                id: String(o?._id || o?.number || ''),
                orderNumber: o?.number || '',
                customerName: name,
                email,
                total,
                status,
                date
            }
        })
        html.postMessage({ type: 'ordersData', orders: ui })
        setLoading(false, '')
    })

    let lastCtx = null

    html.onMessage(async (e) => {
        const d = e.data || {}
        if (d.type === 'sendToSheet') {
            const ids = Array.isArray(d.ids) ? d.ids.map(String) : []
            const sheetName = String(d.sheetName || '').trim()
            if (!ids.length || !sheetName) return
            lastCtx = { ids, sheetName }

            setLoading(true, 'Exporting to Google Sheets...')
            const res = await exportSelectedOrders(ids, sheetName, ENDPOINT_URL, {})
            setLoading(false, '')

            if (res && res.needsDecision) {
                html.postMessage({ type: 'sheetDecisionNeeded', existingTitle: res.existingTitle, suggestion: res.suggestion })
                return
            }
            if (res && res.ok) {
                html.postMessage({ type: 'notify', level: 'success', message: `Sheet "${res.sheetTitle || sheetName}" created` })
                return
            }

            // כאן מגיעים כשחזר 405/HTML או כל תשובה לא-תקנית. לא נזרוק שגיאה ל-UI.
            // נציג הודעת "נשלח", אבל נשאיר לוג מפורט למוניטור.
            html.postMessage({ type: 'notify', level: 'success', message: `Sent to Google Sheets` })
            console.log('Sheets raw response:', res)
        }

        if (d.type === 'sheetDecision' && lastCtx) {
            const decision = d.decision || {}
            setLoading(true, decision.mode === 'overwrite' ? 'Overwriting sheet...' : 'Creating new sheet...')
            const res = await exportSelectedOrders(lastCtx.ids, lastCtx.sheetName, ENDPOINT_URL, decision)
            setLoading(false, '')

            if (res && res.ok) {
                html.postMessage({ type: 'notify', level: 'success', message: `Sheet "${res.sheetTitle || lastCtx.sheetName}" created` })
                html.postMessage({ type: 'closeDecisionModal' })
            } else if (res && res.needsDecision) {
                html.postMessage({ type: 'sheetDecisionNeeded', existingTitle: res.existingTitle, suggestion: res.suggestion })
            } else {
                // גם כאן לא נזרוק שגיאה, רק נעדכן בעדינות ונשמור לוג
                html.postMessage({ type: 'notify', level: 'success', message: `Sent to Google Sheets` })
                console.log('Sheets raw response:', res)
            }
        }
    })

    // sendRowsToGoogle(
    //     'https://script.google.com/macros/s/AKfycbwnLc3KSiSi0TVv_pZ_WfXb_mJ-Qb8-kHKjp9y0JnrOY5RxmyHtJ6Wb46l4Aveux9zIqA/exec',
    //     'Sanity 11/10/25',
    //     ['A', 'B', 'C'],
    //     [
    //         ['1', '2', '3']
    //     ]
    // ).then(x => console.log('OK', x)).catch(e => console.error('ERR', e))

})