#[macro_use]
extern crate lazy_static;

mod utils;
use std::{fmt::Error, ops::{Shl, Shr}};

extern crate base64;

use substring::Substring;

use num_bigint::BigUint;
use std::panic;

use wasm_bindgen::prelude::*;

mod smaz;
use smaz::{compress,decompress};

static PAGE1: &str = include_str!("page1.txt");

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global
// allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

#[wasm_bindgen]
extern {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

macro_rules! log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

#[wasm_bindgen]
pub fn init() {
    utils::set_panic_hook();
}

// Create a list of tuples containing (exponent, name)
static SUFFIXES: &'static [(usize, &'static str)] = &[
    (3003, "Millinillion"),
    (2703, "Nongentillion"),
    (2403, "Octingentillion"),
    (2103, "Septingentillion"),
    (1803, "Sescentillion"),
    (1503, "Quingentillion"),
    (1203, "Quadringentillion"),
    (903, "Trecentillion"),
    (603, "Ducentillion"),
    (573, "Nonagintacentillion"),
    (543, "Octogintacentillion"),
    (513, "Septuagintacentillion"),
    (483, "Sexagintacentillion"),
    (453, "Quinquagintacentillion"),
    (423, "Quadragintacentillion"),
    (393, "Trigintacentillion"),
    (366, "Unviginticentillion"),
    (363, "Viginticentillion"),
    (336, "Undecicentillion"),
    (333, "Decicentillion"),
    (306, "Uncentillion"),
    (303, "Centillion"),
    (273, "Nonagintillion"),
    (243, "Octogintillion"),
    (213, "Septuagintillion"),
    (183, "Sexagintillion"),
    (153, "Quinquagintillion"),
    (123, "Quadragintillion"),
    (120, "Noventrigintillion"),
    (117, "Octotrigintillion"),
    (114, "Septentrigintillion"),
    (111, "Sestrigintillion"),
    (108, "Quintrigintillion"),
    (105, "Quattuortrigintillion"),
    (102, "Trestrigintillion"),
    (99, "Duotrigintillion"),
    (96, "Untrigintillion"),
    (93, "Trigintillion"),
    (90, "Novemvigintillion"),
    (87, "Octovigintillion"),
    (84, "Septemvigintillion"),
    (81, "Sesvigintillion"),
    (78, "Quinvigintillion"),
    (75, "Quattuorvigintillion"),
    (72, "Tresvigintillion"),
    (69, "Duovigintillion"),
    (66, "Unvigintillion"),
    (63, "Vigintillion"),
    (60, "Novendecillion"),
    (57, "Octodecillion"),
    (54, "Septendecillion"),
    (51, "Sedecillion"),
    (48, "Quindecillion"),
    (45, "Quattuordecillion"),
    (42, "Tredecillion"),
    (39, "Duodecillion"),
    (36, "Undecillion"),
    (33, "Decillion"),
    (30, "Nonillion"),
    (27, "Octillion"),
    (24, "Septillion"),
    (21, "Sextillion"),
    (18, "Quintillion"),
    (15, "Quadrillion"),
    (12, "Trillion"),
    (9, "Billion"),
    (6, "Million"),
];

fn find_biggest_suffix(number: usize) -> Option<&'static (usize, &'static str)> {
    for suffix in SUFFIXES {
        if number > suffix.0 {
            return Some(suffix);
        }
    }
    None
}

// Given a BigUInt, return a string representing the number in words
fn biguint_to_words(number: BigUint) -> String {
    let number_string = number.to_str_radix(10);
    let mut length = number_string.len();
    let mut suffix_str = String::new();
    loop {
        match find_biggest_suffix(length) {
            Some((suffix_length, suffix_name)) => {
                length -= suffix_length;
                suffix_str = format!("{} {}", suffix_name, suffix_str);
            },
            None => break
        }
    }

    // Add ' ' between each triplet in number_string, backwards
    let number_string = number_string.substring(0, length);
    let mut number_string_with_spaces = String::new();
    for (i, c) in number_string.chars().rev().enumerate() {
        if i % 3 == 0 && i != 0 {
            number_string_with_spaces.push(' ');
        }
        number_string_with_spaces.push(c);
    }
    number_string_with_spaces = number_string_with_spaces.chars().rev().collect();

    if suffix_str.len() > 0 {
        suffix_str = suffix_str.substring(0, suffix_str.len() - 1).to_string();
    }

    format!("{} {}", number_string_with_spaces, suffix_str)
}

/// Adds whitespace to the end of the string to make it the specified length.
/// If the string is already longer than the specified length, it is truncated.
fn set_string_length_to(string: String, length: usize) -> String {
    let mut result = string;
    while result.chars().count() > length {
        result.pop();
    }
    result
}

fn text_to_page_number(text: String) -> BigUint {
    log!("Compare strings '{}' and '{}'", text, PAGE1);
    if text.eq(&PAGE1) {
        return BigUint::from(1 as u32);
    }
    // 1. Compress text to bytes
    let compressed_text = compress(&text.as_bytes());
    // 3. Interpret bytes as a BigUint
    let compressed_text_number = BigUint::from_bytes_be(&compressed_text[..]);
    // 4. Return the number of the page
    compressed_text_number+BigUint::from(2 as u32)
}

fn page_number_to_text(page_number: BigUint) -> Option<String> {
    if page_number == BigUint::from(0 as u32) {
        return None;
    }
    if page_number < BigUint::from(2 as u32) {
        return Some(PAGE1.to_string());
    }
    let mut page_number = page_number-BigUint::from(2 as u32);
    // 2. Decompress bytes to text
    loop {
        let page_number_text = match decompress(&page_number.to_bytes_be()) {
            Ok(page_number_text) => page_number_text,
            Err(error) => {
                log!("ERROR: decompress failed: {}", error);
                page_number /= BigUint::from(2 as u32);
                continue
            }
        };
        // 3. Interpret text as a String
        match String::from_utf8(page_number_text) {
            Ok(page_number_text) => return Some(page_number_text),
            Err(_) => {
                page_number /= BigUint::from(2 as u32);
                continue
            }
        };
    }    
}

fn page_number_to_base64_string(page_number: BigUint) -> String {
    base64::encode_config(page_number.to_bytes_be(), base64::URL_SAFE)
}

fn base64_string_to_page_number(base64_string: String) -> Option<BigUint> {
   let page_number = match base64::decode_config(base64_string, base64::URL_SAFE) {
        Ok(bytes) => BigUint::from_bytes_be(&bytes[..]),
        Err(_) => return None
    };
    if page_number == BigUint::from(0 as u32) {
        return None;
    } else {
        return Some(page_number);
    }
}

#[wasm_bindgen]
pub fn get_page(page_number: String) -> Option<String> {
    let page_number = match BigUint::parse_bytes(page_number.as_bytes(), 10) {
        Some(page_number) => page_number,
        None => return None
    };
    let text = match page_number_to_text(page_number) {
        Some(text) => text,
        None => return None
    };
    Some(set_string_length_to(text, 2000))
}

#[wasm_bindgen]
pub fn get_pagename(page_number: String) -> Option<String> {
    let page_number = match BigUint::parse_bytes(page_number.as_bytes(), 10) {
        Some(page_number) => page_number,
        None => return None
    };
    Some(biguint_to_words(page_number))
}

#[wasm_bindgen]
pub fn get_search(text: String) -> String {
    let text = set_string_length_to(text, 2000);
    text_to_page_number(text).to_str_radix(10)
}

#[wasm_bindgen]
pub fn page_number_to_base64(page_number: String) -> Option<String> {
    let page_number = match BigUint::parse_bytes(page_number.as_bytes(), 10) {
        Some(page_number) => page_number,
        None => return None
    };
    Some(page_number_to_base64_string(page_number))
}

#[wasm_bindgen]
pub fn base64_to_page_number(base64_string: String) -> Option<String> {
    match base64_string_to_page_number(base64_string) {
        Some(page_number) => Some(page_number.to_str_radix(10)),
        None => None
    }
}
