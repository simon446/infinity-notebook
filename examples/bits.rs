//! Measures the model natively: how many bits texts cost and how fast it runs.
//!
//!     cargo run --release --example bits -- model.bin tokens.txt
//!
//! `tokens.txt` has one text per line as space-separated token ids.

use std::rc::Rc;
use std::time::Instant;

use infinity_notebook::model::{Context, Model, EOS};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model = Rc::new(Model::new(std::fs::read(&args[1]).unwrap()).unwrap());
    let texts = std::fs::read_to_string(&args[2]).unwrap();
    let (mut total_bits, mut total_tokens, start) = (0.0, 0, Instant::now());
    for line in texts.lines() {
        let tokens: Vec<usize> = line.split_whitespace().map(|t| t.parse().unwrap()).collect();
        let mut context = Context::new(Rc::clone(&model));
        context.feed(EOS);
        let mut bits = 0.0;
        for &token in &tokens {
            let logits = context.logits();
            let max = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max) as f64;
            let sum: f64 = logits.iter().map(|&l| (l as f64 - max).exp()).sum();
            bits -= (logits[token] as f64 - max - sum.ln()) / std::f64::consts::LN_2;
            context.feed(token as u32);
        }
        println!("{} tokens, {:.0} bits", tokens.len(), bits);
        total_bits += bits;
        total_tokens += tokens.len();
    }
    let per_token = start.elapsed().as_secs_f64() * 1000.0 / total_tokens.max(1) as f64;
    println!("total {:.0} bits, {:.1} ms per token", total_bits, per_token);
}
