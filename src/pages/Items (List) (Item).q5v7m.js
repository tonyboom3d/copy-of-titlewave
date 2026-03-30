import wixWindow from 'wix-window'
import wixLocation from 'wix-location'
import { getFilteredProductOptions } from 'backend/editLogics.web'
import { updateOrderLineItems } from 'backend/orderUpdates.web'
import { getOrderForAdmin } from 'backend/editLogics.web'
import { authentication } from 'wix-members-frontend'
import { checkMemberRoles } from 'backend/adminAuth.web'

const norm = x => Array.isArray(x) ? x : []
const lower = x => (x || '').toString().toLowerCase()
const textOr = (a, b) => a || b || ''
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`
const n = x => (x || '').toString()

let editState = new Map()

const descName = d => textOr(d?.name?.translated, d?.name?.original)
const descVal = d => textOr(
    d?.plainTextValue?.translated,
    textOr(d?.plainText?.translated, textOr(d?.plainTextValue?.original, d?.plainText?.original))
)

const extractSize = lines => {
    if (!Array.isArray(lines)) return ''
    const hit = lines.find(x => lower(descName(x)).includes('size'))
    return hit ? descVal(hit) : ''
}

const extractColor = lines => {
    if (!Array.isArray(lines)) return ''
    const hit = lines.find(x => x?.lineType === 'COLOR' || lower(descName(x)).includes('color'))
    if (!hit) return ''
    return textOr(hit?.colorInfo?.original, hit?.colorInfo?.translated) || (hit?.color || '')
}

const extractNameNumber = lines => {
    if (!Array.isArray(lines)) return ''
    const hit = lines.find(x => {
        const nm = lower(descName(x))
        return nm.includes('name') || nm.includes('number')
    })
    return hit ? descVal(hit) : ''
}

const wixImageToStatic = url => {
    if (!url || typeof url !== 'string') return ''
    if (!url.startsWith('wix:image://')) return url
    const base = url.split('#')[0]
    const after = base.startsWith('wix:image://v1/') ? base.slice('wix:image://v1/'.length) : base.replace('wix:image://', '')
    const mediaId = after.split('/')[0]
    return `https://static.wixstatic.com/media/${mediaId}`
}

const extractImageUrl = img => {
    if (!img) return ''
    if (typeof img === 'string') return wixImageToStatic(img)
    if (img.uri) return img.uri
    if (img.url) return img.url
    return ''
}

const buildRows = items => {
    if (!Array.isArray(items)) return []
    const rows = []
    items.forEach((li, idx) => {
        const d = li?.descriptionLines || []
        const base = {
            product_id: li?.catalogReference?.catalogItemId || li?.rootCatalogItemId || '',
            product_image: extractImageUrl(li?.image),
            product_name: textOr(li?.productName?.translated, li?.productName?.original),
            product_size: extractSize(d),
            product_color: extractColor(d),
            product_color_hex: '',
            name_number: extractNameNumber(d)
        }
        const qty = Math.max(1, Number(li?.quantity) || 1)
        for (let i = 0; i < qty; i++) rows.push({ ...base, _rowKey: `${idx}-${i}` }) // ✅ מתחיל מ-0
    })
    return rows
}

const toDropdownOptions = arr => (arr || []).map(c => ({
    label: c.description || c.value || '',
    value: c.value || ''
}))

// ✅ פונקציה חדשה להצגת הריפיטר עם אנימציה
function showRepeaterWithAnimation() {
    const repeater = $w('#editRepeater')
    const arrow = $w('#arrow')

    if (repeater && repeater.collapsed) {
        repeater.expand()
        // אנימציה: fade in + slide down
        repeater.show('fade', { duration: 400 })
    }

    if (arrow && arrow.collapsed) {
        arrow.expand()
        arrow.show('fade', { duration: 400 })
    }
}

let isEditingAllowed = true

function wireRepeater() {
    if (!$w('#editRepeater')) return

    $w('#editRepeater').onItemReady(async ($item, itemData, index) => {
        const id = itemData._id
        const st = {
            initial: {
                size: itemData.initial_size,
                color: itemData.initial_color,
                colorHex: itemData.initial_color_hex,
                nameNum: itemData.initial_nameNum,
                image: itemData.product_image
            },
            current: {
                size: itemData.initial_size,
                color: itemData.initial_color,
                colorHex: itemData.initial_color_hex,
                nameNum: itemData.initial_nameNum,
                image: itemData.product_image
            },
            options: { sizes: [], colors: [] }
        }
        editState.set(id, st)

        // Prefill SIZE immediately from initial (so the user sees a value even before we fetch options)
        if ($item('#sizeDropdown')) {
            if (st.current.size) {
                const opt = [{ label: st.current.size, value: st.current.size }];
                $item('#sizeDropdown').options = opt;
                $item('#sizeDropdown').value = st.current.size;
                $item('#sizeDropdown').expand();
            } else {
                $item('#sizeDropdown').collapse();
            }
        }

        // Prefill COLOR and swatch immediately from initial
        if ($item('#colorDropdown')) {
            if (st.current.color) {
                const opt = [{ label: st.current.color, value: st.current.color }];
                $item('#colorDropdown').options = opt;
                $item('#colorDropdown').value = st.current.color;
                $item('#colorDropdown').expand();
            } else {
                $item('#colorDropdown').collapse();
            }
        }

        if ($item('#selectedColor')) {
            if (st.current.colorHex) {
                $item('#selectedColor').style.backgroundColor = st.current.colorHex;
                $item('#selectedColor').expand();
            } else {
                $item('#selectedColor').collapse();
            }
        }

        // תמונה + שם מוצר
        if ($item('#productImage')) {
            const src = st.current.image
            if (src) {
                $item('#productImage').src = src
                $item('#productImage').expand()
            } else {
                $item('#productImage').collapse()
            }
        }

        if ($item('#productName')) {
            const v = (itemData.product_name || '').toString().trim()
            if (v) {
                $item('#productName').text = v
                $item('#productName').expand()
            } else {
                $item('#productName').collapse()
            }
        }

        // Name & Number
        if ($item('#productNameAndNum')) {
            if (itemData.requires_nameNum) {
                $item('#productNameAndNum').value = itemData.initial_nameNum
                $item('#productNameAndNum').expand()
            } else {
                $item('#productNameAndNum').collapse()
            }
            $item('#productNameAndNum').onInput(() => {
                st.current.nameNum = ($item('#productNameAndNum').value || '').toString().trim()
                refreshSaveButton()
            })
        }

        // הבאת productOptions מהבקאנד
        try {
            const r = await getFilteredProductOptions(itemData.product_id)
            if (r?.ok) {
                const po = r.productOptions || {}
                const sizeKey = Object.keys(po).find(k => lower(k).includes('size'))
                const colorKey = Object.keys(po).find(k => lower(k).includes('color'))

                // SIZE (Dropdown רגיל)
                if (sizeKey && $item('#sizeDropdown')) {
                    const sizeOpts = toDropdownOptions(po[sizeKey].choices)
                    st.options.sizes = sizeOpts
                    if (sizeOpts.length) {
                        $item('#sizeDropdown').options = sizeOpts
                        const pre = st.current.size
                        const found = pre ? sizeOpts.find(o => lower(o.value) === lower(pre)) : null
                        $item('#sizeDropdown').value = found ? found.value : ''
                        $item('#sizeDropdown').expand()
                    } else {
                        $item('#sizeDropdown').collapse()
                    }
                    $item('#sizeDropdown').onChange(() => {
                        st.current.size = $item('#sizeDropdown').value || ''
                        refreshSaveButton()
                    })
                } else if ($item('#sizeDropdown')) {
                    $item('#sizeDropdown').collapse()
                }

                // COLOR (Dropdown רגיל + אלמנט צבע)
                if (colorKey && $item('#colorDropdown')) {
                    const colorChoices = po[colorKey].choices || []

                    // ✅ שמור עותק מלא של הצבעים עם כל הנתונים
                    st.options.colors = colorChoices.map(c => ({
                        value: c.value || '',
                        description: c.description || c.value || '',
                        color: c.color || '',
                        mainMedia: c.mainMedia || ''
                    }))

                    console.log('💾 Saved colors to state:', st.options.colors)

                    if (colorChoices.length) {
                        const colorOpts = colorChoices.map(c => ({
                            label: c.description || c.value || '',
                            value: c.value || ''
                        }))

                        $item('#colorDropdown').options = colorOpts

                        // מצא את הצבע הנוכחי
                        const currentColorValue = st.current.color
                        const currentColorChoice = colorChoices.find(c =>
                            lower(c.value) === lower(currentColorValue)
                        )

                        // אם יש צבע נוכחי, הצג אותו
                        if (currentColorChoice) {
                            $item('#colorDropdown').value = currentColorChoice.value

                            // ✅ עדכן INITIAL STATE גם כן (זה החסר!)
                            st.initial.colorHex = currentColorChoice.color || ''

                            // עדכן את אלמנט הצבע
                            if ($item('#selectedColor')) {
                                if (currentColorChoice.color) {
                                    $item('#selectedColor').style.backgroundColor = currentColorChoice.color
                                    $item('#selectedColor').expand()
                                } else {
                                    $item('#selectedColor').collapse()
                                }
                            }

                            // עדכן תמונה אם יש
                            if (currentColorChoice.mainMedia && $item('#productImage')) {
                                $item('#productImage').src = currentColorChoice.mainMedia
                                st.current.image = currentColorChoice.mainMedia
                                st.initial.image = currentColorChoice.mainMedia // ✅ גם פה
                            }

                            st.current.colorHex = currentColorChoice.color || ''
                        } else {
                            // אם אין צבע נוכחי, בחר את הראשון
                            $item('#colorDropdown').value = colorOpts[0].value

                            if ($item('#selectedColor') && colorChoices[0].color) {
                                $item('#selectedColor').style.backgroundColor = colorChoices[0].color
                                $item('#selectedColor').expand()
                            }
                        }

                        // אירוע שינוי צבע
                        $item('#colorDropdown').onChange(() => {
                            const selectedValue = $item('#colorDropdown').value
                            const selectedChoice = colorChoices.find(c => c.value === selectedValue)

                            if (selectedChoice) {
                                // עדכן state
                                st.current.color = selectedChoice.value
                                st.current.colorHex = selectedChoice.color || ''

                                // עדכן אלמנט צבע
                                if ($item('#selectedColor')) {
                                    if (selectedChoice.color) {
                                        $item('#selectedColor').style.backgroundColor = selectedChoice.color
                                        $item('#selectedColor').expand()
                                    } else {
                                        $item('#selectedColor').collapse()
                                    }
                                }

                                // עדכן תמונה אם יש
                                if (selectedChoice.mainMedia && $item('#productImage')) {
                                    $item('#productImage').src = selectedChoice.mainMedia
                                    st.current.image = selectedChoice.mainMedia
                                } else if ($item('#productImage')) {
                                    // אם אין תמונה לצבע, חזור לתמונה המקורית
                                    $item('#productImage').src = st.initial.image
                                    st.current.image = st.initial.image
                                }

                                console.log('Color changed:', {
                                    value: st.current.color,
                                    hex: st.current.colorHex,
                                    image: st.current.image
                                })

                                refreshSaveButton()
                            }
                        })

                        $item('#colorDropdown').expand()
                    } else {
                        $item('#colorDropdown').collapse()
                        if ($item('#selectedColor')) $item('#selectedColor').collapse()
                    }
                } else {
                    if ($item('#colorDropdown')) $item('#colorDropdown').collapse()
                    if ($item('#selectedColor')) $item('#selectedColor').collapse()
                }
            }
        } catch (e) {
            console.error('Error loading product options:', e)
        }

        // ✅ RESET לאייטם - תוקן
        // ✅ RESET לאייטם - תוקן
        if ($item('#rReset')) {
            $item('#rReset').onClick(() => {
                // אפס את ה-state
                st.current = { ...st.initial }

                // Reset size
                if ($item('#sizeDropdown') && !$item('#sizeDropdown').collapsed) {
                    const opts = st.options.sizes || []
                    const pre = st.current.size
                    const found = pre ? opts.find(o => lower(o.value) === lower(pre)) : null
                    $item('#sizeDropdown').value = found ? found.value : ''
                }

                // Reset name/number
                if ($item('#productNameAndNum') && !$item('#productNameAndNum').collapsed) {
                    $item('#productNameAndNum').value = st.current.nameNum || ''
                }

                // Reset color
                if ($item('#colorDropdown') && !$item('#colorDropdown').collapsed) {
                    const initialColorValue = st.initial.color
                    const initialColorChoice = st.options.colors.find(c =>
                        lower(c.value) === lower(initialColorValue) ||
                        lower(c.description) === lower(initialColorValue)
                    )

                    if (initialColorChoice) {
                        $item('#colorDropdown').value = initialColorChoice.value

                        if ($item('#selectedColor')) {
                            if (initialColorChoice.color) {
                                $item('#selectedColor').style.backgroundColor = initialColorChoice.color
                                $item('#selectedColor').expand()
                            } else {
                                $item('#selectedColor').collapse()
                            }
                        }

                        st.current.color = initialColorChoice.value
                        st.current.colorHex = initialColorChoice.color || ''

                        if (initialColorChoice.mainMedia && $item('#productImage')) {
                            $item('#productImage').src = initialColorChoice.mainMedia
                            st.current.image = initialColorChoice.mainMedia
                        } else if (st.initial.image && $item('#productImage')) {
                            $item('#productImage').src = st.initial.image
                            st.current.image = st.initial.image
                        }
                    }
                }

                // Reset image
                if ($item('#productImage')) {
                    $item('#productImage').src = st.current.image
                }

                console.log('Reset to initial:', st.current)
                refreshSaveButton()

                // ✅ הסר את האייטם עם אנימציה
                setTimeout(() => {
                    const currentData = $w('#editRepeater').data || []
                    const newData = currentData.filter(item => item._id !== id)

                    $item('#repeaterContainer').hide('fade', { duration: 300 }).then(() => {
                        $w('#editRepeater').data = newData
                        editState.delete(id)

                        // אם הריפיטר ריק, הסתר אותו והחץ
                        if (newData.length === 0) {
                            if ($w('#editRepeater')) $w('#editRepeater').collapse()
                            if ($w('#arrow')) $w('#arrow').collapse()
                        }

                        console.log('Item removed:', id)
                    })
                }, 100)
            })
        }

        if (!isEditingAllowed) {
            if ($item('#sizeDropdown')) $item('#sizeDropdown').disable()
            if ($item('#colorDropdown')) $item('#colorDropdown').disable()
            if ($item('#productNameAndNum')) $item('#productNameAndNum').disable()
            if ($item('#rReset')) {
                $item('#rReset').disable()
                $item('#rReset').hide() // ✅ הסתר לגמרי את כפתור RESET
            }
        } else {
            // אם עריכה מותרת, אפשר את השדות
            if ($item('#sizeDropdown') && !$item('#sizeDropdown').collapsed) $item('#sizeDropdown').enable()
            if ($item('#colorDropdown') && !$item('#colorDropdown').collapsed) $item('#colorDropdown').enable()
            if ($item('#productNameAndNum') && !$item('#productNameAndNum').collapsed) $item('#productNameAndNum').enable()
            if ($item('#rReset')) {
                $item('#rReset').enable()
                $item('#rReset').show()
            }
        }

        refreshSaveButton()
    })
}

function disableAllEditing() {
    isEditingAllowed = false // ✅ סמן שעריכה מושבתת

    // השבת את כפתור השמירה
    if ($w('#saveAll')) {
        $w('#saveAll').disable()
        $w('#saveAll').label = 'Editing Disabled'
    }

    // הסתר את החץ והריפיטר
    if ($w('#arrow')) $w('#arrow').collapse()
    if ($w('#editRepeater')) {
        $w('#editRepeater').data = []
        $w('#editRepeater').collapse()
    }

    console.log('🔒 All editing disabled')
}

function enableAllEditing() {
    isEditingAllowed = true // ✅ סמן שעריכה מותרת

    // אפשר את כפתור השמירה
    if ($w('#saveAll')) {
        $w('#saveAll').label = 'Save All'
        $w('#saveAll').disable() // יישאר disabled עד שיהיו שינויים
    }

    console.log('🔓 Editing enabled')
}

function wireTable() {
    if (!$w('#productsTable')) return
    $w('#productsTable').onRowSelect(async ev => {
        // ✅ אם עריכה מושבתת, אל תאפשר הוספת שורות
        if (!isEditingAllowed) {
            console.log('⛔ Editing is disabled')
            return
        }

        const row = ev.rowData || {}
        console.log("Selected row:", row)

        // בדוק אם השורה הזו כבר קיימת בריפיטר
        const existingData = $w('#editRepeater').data || []
        const alreadyExists = existingData.some(item => item._rowKey === row._rowKey)

        if (alreadyExists) {
            console.log("Row already exists in repeater:", row._rowKey)
            return
        }

        const item = {
            _id: uid(),
            _rowKey: row._rowKey,
            product_id: row.product_id,
            product_image: extractImageUrl(row.product_image),
            product_name: row.product_name,
            initial_size: row.product_size || '',
            initial_color: row.product_color || '',
            initial_color_hex: row.product_color_hex || '',
            initial_nameNum: (row.name_number || '').toString().trim(),
            requires_nameNum: !!((row.name_number || '').toString().trim())
        }

        $w('#editRepeater').data = [...existingData, item]
        console.log("Added item:", item)

        showRepeaterWithAnimation()
    })
}

function wireSaveAll() {
    if (!$w('#saveAll')) return
    $w('#saveAll').onClick(async () => {
        if ($w('#saveError')) $w('#saveError').hide()
        const items = $w('#editRepeater').data || []
        if (!items.length) return

        const invalidIds = []
        const changedItems = [] // ✅ רק אייטמים ששונו

        items.forEach(it => {
            const st = editState.get(it._id)
            if (!st) return

            // בדוק אם יש name/number חסר
            if (it.requires_nameNum) {
                if (!st.current.nameNum || !st.current.nameNum.toString().trim()) {
                    invalidIds.push(it._id)
                    return
                }
            }

            // ✅ בדוק אם האייטם השתנה
            const hasChanged = isDirty(st)

            if (hasChanged) {
                changedItems.push(it) // ✅ רק אם השתנה
            }
        })

        if (invalidIds.length) {
            if ($w('#saveError')) {
                $w('#saveError').text = 'Please fill Name and Number for all required items'
                $w('#saveError').show()
            }
            return
        }

        // ✅ אם אין שינויים בכלל
        if (changedItems.length === 0) {
            if ($w('#saveError')) {
                $w('#saveError').text = 'No changes to save'
                $w('#saveError').style.color = '#FF9800' // כתום
                $w('#saveError').show()
            }
            return
        }

        // ✅ בנה payload רק מאייטמים ששונו
        const payload = changedItems.map(it => {
            const st = editState.get(it._id) || { current: {} }
            return {
                itemId: it._id,
                rowKey: it._rowKey,
                productId: it.product_id,
                productName: it.product_name,
                size: st.current.size || '',
                color: st.current.color || '',
                colorHex: st.current.colorHex || '',
                nameNumber: st.current.nameNum || '',
                image: st.current.image || ''
            }
        })

        console.log('SAVE ALL payload (only changed):', payload)

        // שלח לבקאנד
        try {
            if ($w('#saveAll')) {
                $w('#saveAll').disable()
                $w('#saveAll').label = 'Saving...'
            }

            const path = norm(wixLocation.path)
            const orderId = path.length ? path[path.length - 1] : ''

            if (!orderId) {
                throw new Error('Order ID not found')
            }

            const result = await updateOrderLineItems(orderId, payload)

            if (result.ok) {
                console.log('✅ Order updated successfully:', result)

                // ✅ עדכן את הסטטוס בעמוד
                if ($w('#orderStatus')) {
                    $w('#orderStatus').text = getStatusText('waiting for approval')
                }

                // ✅ עדכן את ההודעה
                if ($w('#orderStatusMessage')) {
                    $w('#orderStatusMessage').text = 'Your changes are waiting for approval. You cannot make additional changes at this time.'
                    $w('#orderStatusMessage').show()
                }

                // ✅ השבת עריכה
                disableAllEditing()

                if ($w('#saveError')) {
                    $w('#saveError').text = `${changedItems.length} item(s) updated successfully! Status: ${result.newStatus}`
                    $w('#saveError').style.color = '#4CAF50'
                    $w('#saveError').show()
                }

                // ✅ אל תנקה את הריפיטר - השאר את האייטמים המעודכנים
                // setTimeout(() => {
                //     $w('#editRepeater').data = []
                //     editState.clear()
                //     if ($w('#editRepeater')) $w('#editRepeater').collapse()
                //     if ($w('#arrow')) $w('#arrow').collapse()
                // }, 2000)

                // ✅ במקום זאת - רענן את הריפיטר עם האייטמים המעודכנים (read-only)
                setTimeout(() => {
                    // הריפיטר כבר מכיל את האייטמים המעודכנים
                    // פשוט נשאיר אותו פתוח ונשבית את כל השדות
                    if ($w('#editRepeater')) {
                        // טען מחדש את הריפיטר כדי להפעיל את ההשבתה
                        const currentData = $w('#editRepeater').data
                        $w('#editRepeater').data = []
                        setTimeout(() => {
                            $w('#editRepeater').data = currentData
                        }, 50)
                    }
                }, 1500)
            } else {
                console.error('❌ Failed to update order:', result)

                if ($w('#saveError')) {
                    $w('#saveError').text = result.message || 'Failed to update order'
                    $w('#saveError').style.color = '#F44336'
                    $w('#saveError').show()
                }
            }

        } catch (error) {
            console.error('Error saving order:', error)
            if ($w('#saveError')) {
                $w('#saveError').text = 'Error: ' + error.message
                $w('#saveError').style.color = '#F44336'
                $w('#saveError').show()
            }
        } finally {
            if ($w('#saveAll')) {
                $w('#saveAll').disable()
                $w('#saveAll').label = 'Save Changes'
            }
        }
    })
}

const formatAddress = a => {
    if (!a) return ''
    const street = [a?.streetAddress?.name, a?.streetAddress?.number].filter(Boolean).join(' ')
    const apt = a?.streetAddress?.apt ? 'Apt ' + a?.streetAddress?.apt : ''
    const city = a?.city || ''
    const country = a?.country || ''
    const postal = a?.postalCode || ''
    const left = [street, apt].filter(Boolean).join(', ')
    const right = [city, country, postal].filter(Boolean).join(', ')
    return [left, right].filter(Boolean).join(', ')
}

function handleOrderStatus(order, { isAdmin = false } = {}) {
    const status = (order.orderStatus || 'Pending').toString();

    // במצב אדמין: מציגים סטטוס בלבד, ללא השבתה/הסתרה
     $w('#orderStatus').text = getStatusText(status);
    if (isAdmin) {
        if ($w('#orderStatus')) {
           
            $w('#orderStatus').expand();
        }
        if ($w('#orderStatusMessage')) $w('#orderStatusMessage').hide();
        return; // <<< לא לקרוא disableAllEditing/enableAllEditing
    }
    // מצב רגיל (כמו שהיה)
    switch (status.toLowerCase()) {
    case 'waiting for approval':
        disableAllEditing();
        if ($w('#orderStatusMessage')) {
            $w('#orderStatusMessage').text ='Your changes are waiting for approval. You cannot make additional changes at this time.';
            $w('#orderStatusMessage').show();
        }
        break;
    case 'approved':
        disableAllEditing();
        if ($w('#orderStatusMessage')) {
            $w('#orderStatusMessage').text = 'Your changes have been approved. No further edits are allowed.';
            $w('#orderStatusMessage').show();
        }
        break;
    case 'shipped':
        disableAllEditing();
        if ($w('#orderStatusMessage')) {
            $w('#orderStatusMessage').text = 'Your order has been shipped. No changes can be made.';
            $w('#orderStatusMessage').show();
        }
        break;
    case 'cancelled':
    case 'canceled':
        disableAllEditing();
        if ($w('#orderStatusMessage')) {
            $w('#orderStatusMessage').text = 'This order has been cancelled.';
            $w('#orderStatusMessage').show();
        }
        break;
    case 'pending':
    default:
        enableAllEditing();
        if ($w('#orderStatusMessage')) $w('#orderStatusMessage').hide();
        break;
    }
}

function getStatusText(status) {
    console.log("status", status);
    const statusMap = {
        'waiting for approval': '⏳ Waiting for Approval',
        'approved': '✅ Approved',
        'shipped': '📦 Shipped',
        'cancelled': '❌ Cancelled',
        'canceled': '❌ Cancelled',
        'pending (24h)': '⏱️ Pending (24h)'
    }
    return statusMap[status.toLowerCase()] || status
}

function wireAuth() {
    const path = norm(wixLocation.path)
    const orderId = path.length ? path[path.length - 1] : ''

    // ✅ בדוק אם יש admin=true בקישור
    const query = wixLocation.query
    const isAdminMode = query.admin === 'true'

    if (isAdminMode) {
        // ✅ מצב Admin - התחבר ובדוק הרשאות
        handleAdminAuth(orderId)
    } else {
        // ✅ מצב רגיל - פתח Lightbox
        wixWindow.openLightbox('AuthLightbox', { orderId }).then(res => {
            if (!res || !res.ok) return
            displayOrderDetails(res.order)
        })
    }
}

async function handleAdminAuth(orderId) {
    try {
        // ✅ בדוק אם משתמש מחובר
        const isLoggedIn = authentication.loggedIn()

        if (!isLoggedIn) {
            // ✅ בקש התחברות
            authentication.promptLogin({
                mode: 'login',
                modal: true
            }).then(() => {
                // אחרי התחברות מוצלחת - נסה שוב
                handleAdminAuth(orderId)
            }).catch((error) => {
                console.error('Login cancelled or failed:', error)
            })
            return
        }

        // ✅ משתמש מחובר - בדוק תפקידים
        const roleCheck = await checkMemberRoles()

        if (!roleCheck.ok || (!roleCheck.isAdmin && !roleCheck.isContributor && !roleCheck.isOwner)) {
            // ✅ אין הרשאות
            console.error('Access denied: Admin permissions required')
            if ($w('#saveError')) {
                $w('#saveError').text = 'Access denied: Admin permissions required'
                $w('#saveError').style.color = '#F44336'
                $w('#saveError').show()
            }
            return
        }

        console.log('✅ Admin authenticated:', roleCheck)

        // ✅ שלוף את ההזמנה ישירות (ללא Lightbox)
        const result = await getOrderForAdmin(orderId)
        console.log("result", result);
        if (result.ok) {
            displayOrderDetails(result.order, true) // true = admin mode
        } else {
            console.error('Failed to fetch order:', result)
            if ($w('#saveError')) {
                $w('#saveError').text = 'Order not found'
                $w('#saveError').style.color = '#F44336'
                $w('#saveError').show()
            }
        }

    } catch (error) {
        console.error('Admin auth error:', error)
    }
}

function displayOrderDetails(order, isAdminMode = false) {
    const o = order || {};
    console.log("order", o);

    const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

    // keep your withIds() if you want, but we'll generate fresh ids in the mappers below

    if ($w('#title')) $w('#title').text = `Your Order Details #${o.number}:`;
    if ($w('#counter')) $w('#counter').postMessage({ type: 'TW_COUNTDOWN', createdDate: o._createdDate });

    // --- admin block (replaces your previous isAdminMode handling) ---
    if (isAdminMode) {
        // lock editing in admin (read-only)
        isEditingAllowed = false;

        const fromLineItems = (lis = []) => buildRows(lis).map(r => ({
            _id: uid(),
            _rowKey: r._rowKey,
            product_id: r.product_id,
            product_image: extractImageUrl(r.product_image),
            product_name: r.product_name,
            initial_size: r.product_size || '',
            initial_color: r.product_color || '',
            initial_color_hex: r.product_color_hex || '',
            initial_nameNum: (r.name_number || '').toString().trim(),
            requires_nameNum: !!(r.name_number || '').toString().trim()
        }));

        // NEW: map newLineItems into the same structure your repeater expects
        const fromNewLineItems = (nlis = []) => (nlis || []).map(nli => ({
            _id: uid(),
            _rowKey: nli.rowKey || uid(),
            product_id: nli.productId || '',
            product_image: extractImageUrl(nli.image || ''),
            product_name: nli.productName || '',
            initial_size: nli.size || '',
            initial_color: nli.color || '', // often the hex (value)
            initial_color_hex: nli.colorHex || '', // explicit hex if provided
            initial_nameNum: (nli.nameNumber || '').toString().trim(),
            requires_nameNum: !!(nli.nameNumber || '').toString().trim()
        }));

        const sourceItems = Array.isArray(o.newLineItems) && o.newLineItems.length ?
            fromNewLineItems(o.newLineItems) :
            fromLineItems(o.lineItems || []);

        if ($w('#editRepeater')) $w('#editRepeater').data = sourceItems;
        if (typeof showRepeaterWithAnimation === 'function') showRepeaterWithAnimation();

        // admin view: read-only
        if ($w('#saveAll')) {
            $w('#saveAll').disable();
            $w('#saveAll').label = 'View Only';
        }
    }
    // --- end admin block ---

    const first = o?.recipientInfo?.contactDetails?.firstName || '';
    const last = o?.recipientInfo?.contactDetails?.lastName || '';
    if ($w('#name')) $w('#name').text = `Name: ${[first, last].filter(Boolean).join(' ')}`;
    if ($w('#email')) $w('#email').text = `Email: ${n(o?.buyerInfo?.email)}`;
    if ($w('#phone')) $w('#phone').text = `Phone: ${n(o?.recipientInfo?.contactDetails?.phone)}`;
    if ($w('#address')) $w('#address').text = `Address: ${formatAddress(o?.recipientInfo?.address)}`;

    // IMPORTANT: don't wipe UI in admin
    handleOrderStatus(o, { isAdmin: isAdminMode });

    // products table (view)
    const rows = buildRows(o?.lineItems);
    if ($w('#productsTable')) $w('#productsTable').rows = rows;
    wireTable();

    if ($w('#box1')) $w('#box1').collapse();
}

const isDirty = st =>
    (st.current.size || '') !== (st.initial.size || '') ||
    (st.current.color || '') !== (st.initial.color || '') ||
    (st.current.nameNum || '') !== (st.initial.nameNum || '')

function refreshSaveButton() {
    const anyDirty = Array.from(editState.values()).some(isDirty)
    if ($w('#saveAll')) anyDirty ? $w('#saveAll').enable() : $w('#saveAll').disable()
}

$w.onReady(function () {
    // ✅ הסתר ריפיטר וחץ בהתחלה
    if ($w('#editRepeater')) {
        $w('#editRepeater').data = []
        $w('#editRepeater').collapse()
    }
    wireRepeater()
    wireSaveAll()
    wireAuth()
})