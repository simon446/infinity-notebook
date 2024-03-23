import * as wasm from "infinity-notebook";

wasm.init();
const relativeUrl = location.hostname === 'localhost' ? '' : 'infinity-notebook/';
const b64pathLegacy = window.location.search.substring(1);
const b64path = window.location.hash.substring(1);
const pageNumber = wasm.base64_to_page_number(b64path);
if (b64pathLegacy !== "") window.location.href = `/${relativeUrl}#`+b64pathLegacy;
else if (pageNumber === undefined) window.location.href = `/${relativeUrl}#`+wasm.page_number_to_base64("1");
else {

window.document.title += `: ${wasm.get_pagename(pageNumber)}`;
var paper = document.getElementById('content');
var pageNumberElement = document.getElementById('pagenum');
const pageContent = wasm.get_page(pageNumber);
paper.value = pageContent;
pageNumberElement.value = "Page "+wasm.get_pagename(pageNumber);

paper.addEventListener('keypress', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        window.location.href = `/${relativeUrl}#`+wasm.page_number_to_base64(wasm.get_search(paper.value));
    }
});

let searchMode = false;
let pageMode = false;
paper.addEventListener('input', function (e) {
    paper.value = wasm.limit_string_length(paper.value);
    if (paper.value === pageContent) {
        searchMode = false;
        pageNumberElement.value = "Page "+wasm.get_pagename(pageNumber);
        pageNumberElement.readOnly = false;
        pageNumberElement.classList.remove("colored");
    } else {
        pageNumberElement.value = "Press Enter to search";
        searchMode = true;
        pageNumberElement.readOnly = true;
        pageNumberElement.classList.add("colored");
    }
});

pageNumberElement.addEventListener('input', function (e) {
    if (pageNumberElement.value === pageNumber) {
        pageMode = false;
        paper.value = pageContent;
        paper.readOnly = false;
        paper.classList.remove("colored");
    } else {
        pageMode = true;
        paper.value = "Press Enter to go to page";
        paper.readOnly = true;
        paper.classList.add("colored");
    }
});

pageNumberElement.addEventListener("focusin", function (e) {
    if (searchMode) { e.preventDefault(); return; }
    pageNumberElement.value = pageNumber;
    setTimeout(() => { this.setSelectionRange(0, this.value.length) }, 10)
});
function navigate() {
    if (pageNumberElement.value != pageNumber) {
        window.location.href = `/${relativeUrl}#`+wasm.page_number_to_base64(pageNumberElement.value);
    } else {
        pageNumberElement.value = "Page "+wasm.get_pagename(pageNumber);
    }
}
pageNumberElement.addEventListener('focusout', (event) => {
    if (searchMode) return;
    pageMode = false;
    paper.value = pageContent;
    paper.readOnly = false;
    paper.classList.remove("colored");
    pageNumberElement.value = "Page "+wasm.get_pagename(pageNumber);
});
pageNumberElement.addEventListener('keypress', function (e) {
    if (searchMode) return;
    if (e.key === 'Enter') {
        navigate();
    } else if (e.key === 'Escape') {
        pageMode = false;
        paper.value = pageContent;
        paper.readOnly = false;
        paper.classList.remove("colored");
        pageNumberElement.value = "Page "+wasm.get_pagename(pageNumber);
        // Unfocus the input field
        pageNumberElement.blur();
    }
});

}
