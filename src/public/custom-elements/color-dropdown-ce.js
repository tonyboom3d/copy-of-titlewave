/* public/color-dropdown-ce.js */

const template = document.createElement('template')
template.innerHTML = `
<style>
:host {
  display: block;
  width: 100%;
  min-height: 80px;
  position: relative;
}

.wrapper {
  width: 100%;
  position: relative;
}

.label {
  font-size: 12px;
  margin: 0 0 6px 2px;
  color: #1D2541;
  font-weight: 600;
}

.control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 42px;
  border: 1px solid #1D2541;
  border-radius: 4px;
  background: #FFFFFF;
  padding: 0 12px;
  cursor: pointer;
  box-sizing: border-box;
}

.control-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid rgba(29,37,65,.2);
  display: none;
  flex: 0 0 18px;
}

.swatch.visible {
  display: block;
}

.value-display {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #7b859f;
  font-size: 14px;
}

.value-display.selected {
  color: #1D2541;
  font-weight: 600;
}

.chevron {
  font-weight: 700;
  color: #1D2541;
  font-size: 16px;
  user-select: none;
}

.dropdown-list {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  border: 1px solid #1D2541;
  border-radius: 4px;
  background: #FFFFFF;
  max-height: 240px;
  overflow: auto;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.dropdown-list.open {
  display: block;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.dropdown-item:hover {
  background: rgba(6,195,221,.10);
}

.item-swatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid rgba(29,37,65,.2);
  flex-shrink: 0;
}

.item-label {
  font-size: 14px;
  color: #1D2541;
}

.empty-message {
  font-size: 13px;
  color: #7b859f;
  padding: 10px 12px;
}
</style>

<div class="wrapper">
  <div class="label"></div>
  <div class="control">
    <div class="control-left">
      <div class="swatch"></div>
      <div class="value-display">Select Color</div>
    </div>
    <span class="chevron">▾</span>
  </div>
  <div class="dropdown-list"></div>
</div>
`

class ColorDropdown extends HTMLElement {
  static get observedAttributes() { 
    return ['label', 'options', 'value', 'debug'] 
  }

  constructor() {
    super()
    
    // State
    this.state = { 
      label: 'Color', 
      options: [], 
      value: '' 
    }
    this._open = false

    // Shadow DOM
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.appendChild(template.content.cloneNode(true))

    // קבלת אלמנטים מה-Shadow DOM
    this.labelEl = shadow.querySelector('.label')
    this.control = shadow.querySelector('.control')
    this.swatch = shadow.querySelector('.swatch')
    this.valueDisplay = shadow.querySelector('.value-display')
    this.chevron = shadow.querySelector('.chevron')
    this.dropdownList = shadow.querySelector('.dropdown-list')

    // Event listeners
    this.control.addEventListener('click', () => this.toggle())
    this.onDocClick = this.onDocClick.bind(this)
  }

  connectedCallback() {
    this.log('connected - element is now in DOM')
    this.render()
    document.addEventListener('click', this.onDocClick)
    
    // Dispatch ready event
    setTimeout(() => {
      this.dispatchEvent(new CustomEvent('tw-ready', { 
        bubbles: true, 
        composed: true,
        detail: { element: this }
      }))
      this.log('tw-ready event dispatched')
    }, 50)
  }

  disconnectedCallback() {
    this.log('disconnected')
    document.removeEventListener('click', this.onDocClick)
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return

    if (name === 'label') {
      this.state.label = newValue || 'Color'
    }
    
    if (name === 'options') {
      try {
        const parsed = JSON.parse(newValue || '[]')
        this.state.options = Array.isArray(parsed) ? parsed : []
      } catch(e) {
        console.error('[color-ce] Invalid options JSON:', e)
        this.state.options = []
      }
    }
    
    if (name === 'value') {
      this.state.value = newValue || ''
    }

    this.log('attributeChanged:', { name, newValue, state: this.state })
    this.render()
  }

  log(...args) {
    const debug = (this.getAttribute('debug') || '').toString().trim()
    if (debug === '1' || debug.toLowerCase() === 'true') {
      console.log('[color-ce]', ...args)
    }
  }

  onDocClick(e) {
    if (!this.contains(e.target)) {
      this.close()
    }
  }

  open() {
    this._open = true
    this.dropdownList.classList.add('open')
    this.log('opened')
  }

  close() {
    this._open = false
    this.dropdownList.classList.remove('open')
    this.log('closed')
  }

  toggle() {
    this._open ? this.close() : this.open()
  }

  select(opt) {
    this.state.value = opt.value || ''
    this.render()
    this.log('select', opt)
    
    this.dispatchEvent(new CustomEvent('tw-change', {
      detail: { 
        value: this.state.value, 
        label: opt.description || opt.value || '', 
        hex: opt.color || '' 
      },
      bubbles: true, 
      composed: true
    }))
    
    this.close()
  }

  render() {
    // Update label
    this.labelEl.textContent = this.state.label || 'Color'

    // Update selected display
    const selectedOption = this.state.options.find(o => 
      (o.value || '') === this.state.value
    )

    if (selectedOption) {
      this.valueDisplay.textContent = selectedOption.description || selectedOption.value || ''
      this.valueDisplay.classList.add('selected')
      this.swatch.style.background = selectedOption.color || '#CCCCCC'
      this.swatch.classList.add('visible')
    } else {
      this.valueDisplay.textContent = 'Select Color'
      this.valueDisplay.classList.remove('selected')
      this.swatch.classList.remove('visible')
    }

    // Build dropdown list
    this.dropdownList.innerHTML = ''

    if (!this.state.options.length) {
      const empty = document.createElement('div')
      empty.className = 'empty-message'
      empty.textContent = 'No colors available'
      this.dropdownList.appendChild(empty)
    } else {
      this.state.options.forEach(opt => {
        const item = document.createElement('div')
        item.className = 'dropdown-item'

        const itemSwatch = document.createElement('div')
        itemSwatch.className = 'item-swatch'
        itemSwatch.style.background = opt.color || '#CCCCCC'

        const itemLabel = document.createElement('div')
        itemLabel.className = 'item-label'
        itemLabel.textContent = opt.description || opt.value || ''

        item.appendChild(itemSwatch)
        item.appendChild(itemLabel)

        item.addEventListener('click', () => this.select(opt))

        this.dropdownList.appendChild(item)
      })
    }

    this.log('rendered', { 
      optionsCount: this.state.options.length, 
      value: this.state.value 
    })
  }
}

customElements.define('color-ce', ColorDropdown)
console.log('[color-ce] ✅ Custom Element defined successfully')