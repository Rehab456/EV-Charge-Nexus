document.addEventListener('DOMContentLoaded', async () => {
 const make = document.getElementById('manufacturer');
 const model = document.getElementById('model');
 const makeList = document.getElementById('manufacturer-options');
 const modelList = document.getElementById('model-options');
 const help = document.getElementById('catalog-help');
 if (!make || !model) return;
 try {
   const response = await fetch('/static/vehicle_catalog.json');
   if (!response.ok) throw new Error('Catalog unavailable');
   const catalog = await response.json();
   const brands = Object.keys(catalog).sort((a,b)=>a.localeCompare(b));
   brands.forEach(name => makeList.append(new Option('',name)));
   function updateModels(clear) {
     const selected = brands.find(name => name.toLowerCase() === make.value.trim().toLowerCase());
     modelList.replaceChildren();
     if (clear) model.value = '';
     if (selected) {
       catalog[selected].forEach(name => modelList.append(new Option('',name)));
       help.textContent = `${catalog[selected].length} model options for ${selected}. If your exact model is missing, type it manually.`;
     } else {
       help.textContent = 'Brand not listed? Type your manufacturer and model manually.';
     }
   }
   make.addEventListener('input', () => updateModels(true));
   make.addEventListener('change', () => updateModels(true));
   updateModels(false);
 } catch(e) { help.textContent = 'Catalog could not load. You can still enter your vehicle manually.'; }
});
