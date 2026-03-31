import { response, ok, badRequest, serverError } from 'wix-http-functions';
import wixData from 'wix-data';

// כתובת הפונקציה תהיה: https://shirfu.wixsite.com/copy-of-titlewave/_functions/updateOrderFromSheet
export async function post_updateOrderFromSheet(request) {
    try {
        const body = await request.body.json();
        const orderId = body.orderId != null ? String(body.orderId).trim() : '';
        const orderNumberRaw = body.orderNumber != null ? String(body.orderNumber).trim() : '';
        const itemId = body.itemId != null ? String(body.itemId).trim() : '';
        const status = body.status != null ? String(body.status).trim() : '';
        const comment = body.comment != null ? String(body.comment) : '';

        if (!orderId && !orderNumberRaw) {
            return badRequest({ body: { error: "Missing orderId/orderNumber" } });
        }

        const q = wixData.query("ordersStatus");
        let query = q;
        if (orderId) query = query.eq('orderId', orderId);
        if (orderNumberRaw) {
            query = query.eq('orderNumber', orderNumberRaw);
        }

        const res = await query.limit(1).find({ suppressAuth: true, suppressHooks: true });
        const existing = res.items[0] || null;
        if (!existing) return badRequest({ body: { error: "Order not found in ordersStatus" } });

        const next = { ...existing };

        // order-level back office message (Sheet column J)
        if (comment !== undefined) next.backOfficeMsg = comment || "";

        // item-level status update (preferred path)
        if (itemId) {
            const lineItems = Array.isArray(next.lineItems) ? next.lineItems.slice() : [];
            const savedItems = Array.isArray(next.newLineItems) ? next.newLineItems.slice() : [];
            const lineIdx = lineItems.findIndex(x => String(x?.itemId || '').trim() === itemId);
            const savedIdx = savedItems.findIndex(x => String(x?.itemId || '').trim() === itemId);
            if (lineIdx < 0 && savedIdx < 0) {
                return badRequest({ body: { error: "itemId not found on order", itemId } });
            }
            if (lineIdx >= 0) {
                lineItems[lineIdx] = { ...(lineItems[lineIdx] || {}), status: status || (lineItems[lineIdx] && lineItems[lineIdx].status) || '' };
                next.lineItems = lineItems;
            }
            if (savedIdx >= 0) {
                savedItems[savedIdx] = { ...(savedItems[savedIdx] || {}), status: status || (savedItems[savedIdx] && savedItems[savedIdx].status) || '' };
                next.newLineItems = savedItems;
            }
        } else if (status) {
            // fallback: allow order-level status update when itemId isn't provided
            next.orderStatus = [status];
        }

        // 3. עדכון הרשומה חזרה למסד הנתונים
        // suppressHooks: true - קריטי! מונע מה-Hook של ההזמנה לרוץ שוב ולשלוח חזרה לגוגל (מונע לולאה אינסופית)
        await wixData.update("ordersStatus", next, { suppressAuth: true, suppressHooks: true });

        return ok({ body: { success: true, orderId: next.orderId || orderId || '', orderNumber: next.orderNumber || null, itemId: itemId || null } });

    } catch (error) {
        return serverError({ body: { error: error.message } });
    }
}