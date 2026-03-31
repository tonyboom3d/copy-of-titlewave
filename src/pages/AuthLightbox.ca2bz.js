import wixLocation from 'wix-location'
import wixWindow from 'wix-window'
import { verifyOrderAndStatus } from 'backend/editLogics.web'

let orderId = ''
const norm = x => Array.isArray(x) ? x : []

$w.onReady(function () {
  const path = norm(wixLocation.path)
  orderId = path.length ? path[path.length - 1] : ''

  if ($w('#submit')) {
    $w('#submit').onClick(() => {
      handleSubmit()
    })
  }
})

async function handleSubmit() {
  $w('#submit').disable()
  $w('#submit').label = 'Loading...'
  const email = $w('#email') ? ($w('#email').value || '') : ''
  const orderNumber = $w('#orderNumber') ? ($w('#orderNumber').value || '') : ''
  const res = await verifyOrderAndStatus(orderId, email, orderNumber)
  $w('#submit').label = 'Submit'
  $w('#submit').enable()
  if (!res || !res.ok) {
    if ($w('#authError')) $w('#authError').text = 'Access denied for the provided details'
    if ($w('#authError')) $w('#authError').show('slide', { direction: 'bottom', duration: 250 })
    setTimeout(() => {
      if ($w('#authError')) $w('#authError').hide('slide', { direction: 'bottom', duration: 250 })
    }, 2700)
    return
  }
  wixWindow.lightbox.close(res)
}

// Note: Lightbox is kept as a fallback. Primary auth UI now lives in the iframe.
