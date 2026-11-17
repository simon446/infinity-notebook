pub mod coder;
pub mod model;
mod utils;

use std::cell::RefCell;
use std::rc::Rc;

use num_bigint::BigUint;
use substring::Substring;
use wasm_bindgen::prelude::*;

static PAGE1: &str = include_str!("page1.txt");
static MAX_STRING_LENGTH: usize = 2000;

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

// Page 0 does not exist and page 1 is the fixed welcome page. Every other page
// number, minus one, is an arithmetic code (see coder.rs) for the page's text
// under the language model in model.rs.

/// One token of the text the model last worked on, with the slice of the
/// number line it got (see `coder::token_slice`).
struct Step {
    token: u32,
    start: u64,
    freq: u64,
}

/// The text the model last worked on. Running the model is the slow part, and
/// the next text usually starts the same way: the neighbouring page when
/// flipping, or the same words with a new ending when editing. Whatever the
/// two have in common is not run through the model again.
struct Memory {
    /// Has been fed the start marker and the tokens of `steps`.
    context: model::Context,
    steps: Vec<Step>,
}

impl Memory {
    /// Forgets all but the first `count` tokens.
    fn rewind(&mut self, count: usize) {
        if count >= self.steps.len() {
            return;
        }
        self.steps.truncate(count);
        // Feed the last remaining token again to get the logits after it.
        self.context.truncate(count);
        self.context.feed(self.steps.last().map_or(model::EOS, |step| step.token));
    }

    /// Appends a token to the text.
    fn push(&mut self, token: u32, start: u64, freq: u64) {
        self.context.feed(token);
        self.steps.push(Step { token, start, freq });
    }
}

/// The language model, loaded from the bytes of its model file.
#[wasm_bindgen]
pub struct Model {
    memory: Rc<RefCell<Memory>>,
}

#[wasm_bindgen]
impl Model {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>) -> Result<Model, JsError> {
        let model = model::Model::new(bytes).map_err(|message| JsError::new(&message))?;
        let mut context = model::Context::new(Rc::new(model));
        // The end-of-text token doubles as the start marker.
        context.feed(model::EOS);
        Ok(Model { memory: Rc::new(RefCell::new(Memory { context, steps: Vec::new() })) })
    }
}

/// True for tokens that can be part of a page's text.
#[wasm_bindgen]
pub fn is_text_token(token: u32) -> bool {
    token >= model::SPECIAL_TOKENS && (token as usize) < model::VOCAB
}

/// Encodes a text, one token at a time, into its page number.
#[wasm_bindgen]
pub struct PageEncoder {
    memory: Rc<RefCell<Memory>>,
    encoder: coder::Encoder,
    /// How many tokens have been pushed.
    count: usize,
}

#[wasm_bindgen]
impl PageEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new(model: &Model) -> PageEncoder {
        PageEncoder {
            memory: Rc::clone(&model.memory),
            encoder: coder::Encoder::new(model::EOS),
            count: 0,
        }
    }

    /// Appends a token for which `is_text_token` holds.
    pub fn push(&mut self, token: u32) {
        let mut memory = self.memory.borrow_mut();
        let (start, freq) = match memory.steps.get(self.count) {
            Some(step) if step.token == token => (step.start, step.freq),
            _ => {
                memory.rewind(self.count);
                let (start, freq) = coder::token_slice(memory.context.logits(), model::EOS, token);
                memory.push(token, start, freq);
                (start, freq)
            }
        };
        self.encoder.narrow(start, freq);
        self.count += 1;
    }

    /// Ends the text and returns the page number in decimal.
    pub fn finish(self) -> String {
        let mut memory = self.memory.borrow_mut();
        memory.rewind(self.count);
        (self.encoder.finish(memory.context.logits()) + 1u32).to_str_radix(10)
    }
}

/// Decodes a page number, one token at a time, back into its text.
#[wasm_bindgen]
pub struct PageDecoder {
    memory: Rc<RefCell<Memory>>,
    decoder: coder::Decoder,
    /// How many tokens have been returned.
    count: usize,
    finished: bool,
}

#[wasm_bindgen]
impl PageDecoder {
    /// Returns nothing for pages 0 and 1, which are not model-coded.
    pub fn create(model: &Model, page_number: String) -> Option<PageDecoder> {
        let page_number = BigUint::parse_bytes(page_number.as_bytes(), 10)?;
        if page_number < BigUint::from(2u32) {
            return None;
        }
        Some(PageDecoder {
            memory: Rc::clone(&model.memory),
            decoder: coder::Decoder::new(&(page_number - 1u32), model::EOS),
            count: 0,
            finished: false,
        })
    }

    /// The next token of the page, or nothing once the page has ended.
    pub fn next(&mut self) -> Option<u32> {
        if self.finished || self.decoder.exhausted() {
            return None;
        }
        let mut memory = self.memory.borrow_mut();
        let target = self.decoder.target();
        let token = match memory.steps.get(self.count) {
            // Still the same text as last time.
            Some(step) if (step.start..step.start + step.freq).contains(&target) => {
                self.decoder.narrow(step.start, step.freq);
                step.token
            }
            _ => {
                memory.rewind(self.count);
                let (token, (start, freq)) = coder::token_at(memory.context.logits(), model::EOS, target);
                if !is_text_token(token) {
                    self.finished = true;
                    return None;
                }
                self.decoder.narrow(start, freq);
                memory.push(token, start, freq);
                token
            }
        };
        self.count += 1;
        Some(token)
    }
}

#[wasm_bindgen]
pub fn first_page() -> String {
    PAGE1.to_string()
}

#[wasm_bindgen]
pub fn get_pagename(page_number: String) -> Option<String> {
    BigUint::parse_bytes(page_number.as_bytes(), 10).map(biguint_to_words)
}

#[wasm_bindgen]
pub fn limit_string_length(string: String) -> String {
    if string.len() > MAX_STRING_LENGTH {
        string.substring(0, MAX_STRING_LENGTH).to_string()
    } else {
        string
    }
}
