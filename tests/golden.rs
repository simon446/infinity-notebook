//! Checks the language model and coder against a known page.
//!
//! The expected code was produced by this very code. If the test fails after
//! a change, that change renumbers every page: links that people have shared
//! stop working.

use std::rc::Rc;

use infinity_notebook::coder::{Decoder, Encoder};
use infinity_notebook::model::{Context, Model, EOS, SPECIAL_TOKENS};
use num_bigint::BigUint;

// The tokens of this text:
// "Remember to call the plumber on Thursday about the leak under the kitchen sink. He said he could come by after four, but I need to be home to let him in. Also pick up milk, eggs and something for dinner, and ask Maria whether she still has the ladder we lent her last summer."
const TOKENS: &[u32] = &[
    9692, 288, 946, 260, 475, 5441, 335, 14963, 563, 260, 12603, 656,
    260, 9902, 14864, 30, 909, 1137, 384, 856, 1690, 411, 990, 1876,
    28, 564, 339, 737, 288, 325, 1478, 288, 1303, 1272, 281, 30,
    4420, 4491, 614, 4788, 28, 5246, 284, 1488, 327, 11494, 28, 284,
    1998, 11924, 1991, 1041, 1361, 553, 260, 23071, 392, 20434, 874, 1596,
    4018, 30,
];

/// Its arithmetic code; the page number is one more.
const CODE: &str = "5641709378246156211764077360178999267515781706967594039080303113589219121587623673022558070957810488877";

fn load_model() -> Rc<Model> {
    let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/www/model");
    let mut file = Vec::new();
    for part in 0.. {
        match std::fs::read(format!("{directory}/model.bin.part{part:02}")) {
            Ok(bytes) => file.extend(bytes),
            Err(_) => break,
        }
    }
    Rc::new(Model::new(file).expect("www/model should hold the model file"))
}

fn new_context(model: &Rc<Model>) -> Context {
    let mut context = Context::new(Rc::clone(model));
    context.feed(EOS);
    context
}

#[test]
fn known_text_keeps_its_page() {
    let model = load_model();

    let mut context = new_context(&model);
    let mut encoder = Encoder::new(EOS);
    for &token in TOKENS {
        encoder.push(context.logits(), token);
        context.feed(token);
    }
    let code = encoder.finish(context.logits());
    assert_eq!(code.to_str_radix(10), CODE);

    let mut context = new_context(&model);
    let mut decoder = Decoder::new(&BigUint::parse_bytes(CODE.as_bytes(), 10).unwrap(), EOS);
    let mut tokens = vec![];
    while !decoder.exhausted() {
        let token = decoder.next(context.logits());
        if token < SPECIAL_TOKENS {
            break;
        }
        tokens.push(token);
        context.feed(token);
    }
    assert_eq!(tokens, TOKENS);
}
