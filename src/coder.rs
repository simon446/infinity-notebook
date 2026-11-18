//! Arithmetic coding driven by a language model's next-token predictions.
//!
//! A page's text is tokenized and each token is coded with the probability the
//! model assigned to it, so a text costs about `-log2 P(text)` bits: the more
//! predictable the text, the smaller its page number.
//!
//! Every number decodes to a text: tokens are read until the number's bits
//! are used up or the model's end-of-text token comes out, so short numbers
//! give short texts. The encoder returns the smallest number that decodes to
//! the tokens it was given.
//!
//! The model itself runs in JavaScript. This module only turns logits into an
//! exact integer distribution and keeps the (arbitrary precision) interval, so
//! that encoder and decoder agree bit for bit. Everything here is integer math
//! except `exp`, which on wasm is the software `libm` implementation and hence
//! identical on every machine.

use num_bigint::BigUint;
use num_traits::{One, Zero};

/// Every distribution is quantized to integer frequencies summing to 2^32.
const TOTAL_BITS: u64 = 32;
const TOTAL: u64 = 1 << TOTAL_BITS;

/// The model's distribution over the next token as integer frequencies.
///
/// Every token gets a frequency of at least 1, so any token can be coded. The
/// token `first` (end-of-text) is placed first on the number line, so the
/// all-zero continuation of a number means "the text ends here".
struct Distribution {
    freqs: Vec<u32>,
    first: usize,
}

impl Distribution {
    fn new(logits: &[f32], first: u32) -> Distribution {
        let first = first as usize;
        assert!(first < logits.len(), "end-of-text token outside the vocabulary");
        let n = logits.len();
        assert!(n >= 2 && (n as u64) < TOTAL / 2, "unexpected vocabulary size");

        let mut top = 0;
        let mut max = f32::NEG_INFINITY;
        for (i, &l) in logits.iter().enumerate() {
            if l.is_finite() && l > max {
                max = l;
                top = i;
            }
        }

        let weights: Vec<f64> = logits
            .iter()
            .map(|&l| if l.is_finite() { ((l - max) as f64).exp() } else { 0.0 })
            .collect();
        let sum: f64 = weights.iter().sum();
        let sum = if sum > 0.0 { sum } else { 1.0 };

        let budget = (TOTAL - n as u64) as f64;
        let mut total: u64 = 0;
        let mut freqs: Vec<u32> = weights
            .iter()
            .map(|w| {
                let f = 1 + (w / sum * budget) as u64;
                total += f;
                f as u32
            })
            .collect();

        // Hand the rounding remainder to the most likely token.
        let top_freq = freqs[top] as u64 + TOTAL - total;
        assert!(top_freq >= 1 && top_freq < TOTAL);
        freqs[top] = top_freq as u32;

        Distribution { freqs, first }
    }

    /// Start of `token`'s slice of [0, 2^32) and its width.
    fn interval(&self, token: usize) -> (u64, u64) {
        let freq = self.freqs[token] as u64;
        if token == self.first {
            return (0, freq);
        }
        let mut start = self.freqs[self.first] as u64;
        for (i, &f) in self.freqs[..token].iter().enumerate() {
            if i != self.first {
                start += f as u64;
            }
        }
        (start, freq)
    }

    /// The token whose slice contains `target`.
    fn find(&self, target: u64) -> usize {
        let mut end = self.freqs[self.first] as u64;
        if target < end {
            return self.first;
        }
        for (i, &f) in self.freqs.iter().enumerate() {
            if i != self.first {
                end += f as u64;
                if target < end {
                    return i;
                }
            }
        }
        self.freqs.len() - 1
    }
}

/// The slice of [0, 2^32) that `token` gets under the model's predictions
/// `logits`, as (start, width). It only depends on the text before the token,
/// so it can be kept and reused for another text that starts the same way.
pub fn token_slice(logits: &[f32], eos: u32, token: u32) -> (u64, u64) {
    Distribution::new(logits, eos).interval(token as usize)
}

/// The token whose slice contains `target`, and that slice.
pub fn token_at(logits: &[f32], eos: u32, target: u64) -> (u32, (u64, u64)) {
    let distribution = Distribution::new(logits, eos);
    let token = distribution.find(target);
    (token as u32, distribution.interval(token))
}

/// The interval `[low, low + range) / 2^(32 * steps)` of all points on the
/// number line that start with the tokens seen so far.
struct Interval {
    low: BigUint,
    range: BigUint,
    steps: u64,
}

impl Interval {
    fn new() -> Interval {
        Interval { low: BigUint::zero(), range: BigUint::one(), steps: 0 }
    }

    fn narrow(&mut self, start: u64, freq: u64) {
        self.low = (&self.low << TOTAL_BITS) + &self.range * start;
        self.range *= freq;
        self.steps += 1;
    }
}

pub struct Encoder {
    interval: Interval,
    /// The width of the interval before the last token narrowed it.
    previous_range: BigUint,
    eos: u32,
}

/// How many bits a code needs before the decoder looks at another token once
/// its interval is `range / 2^(32 * steps)` wide (see `Decoder::exhausted`).
fn bits_to_continue(range: &BigUint, steps: u64) -> u64 {
    (TOTAL_BITS * steps + 1).saturating_sub(range.bits())
}

/// The smallest `value` such that the point `value / 2^bit_count` lies in
/// `[low, low + range) / 2^(32 * steps)`, if there is one.
fn first_point(low: &BigUint, range: &BigUint, steps: u64, bit_count: u64) -> Option<BigUint> {
    let denominator_bits = TOTAL_BITS * steps;
    if bit_count >= denominator_bits {
        return Some(low << (bit_count - denominator_bits));
    }
    let shift = denominator_bits - bit_count;
    let value = (low + (BigUint::one() << shift) - 1u32) >> shift;
    if (&value << shift) < low + range {
        Some(value)
    } else {
        None
    }
}

impl Encoder {
    pub fn new(eos: u32) -> Encoder {
        Encoder { interval: Interval::new(), previous_range: BigUint::one(), eos }
    }

    pub fn push(&mut self, logits: &[f32], token: u32) {
        let (start, freq) = token_slice(logits, self.eos, token);
        self.narrow(start, freq);
    }

    /// Appends a token by its slice (see `token_slice`).
    pub fn narrow(&mut self, start: u64, freq: u64) {
        self.previous_range = self.interval.range.clone();
        self.interval.narrow(start, freq);
    }

    /// A lower bound on the number of bits of the code so far.
    pub fn bits(&self) -> u64 {
        (TOTAL_BITS * self.interval.steps).saturating_sub(self.interval.range.bits())
    }

    /// Ends the text and returns its smallest code. `logits` are the model's
    /// predictions for what follows the text.
    ///
    /// A code is a bit string `b`, stored as the number `1b` so that leading
    /// zeros survive, such that the decoder reads the point `0.b` as exactly
    /// these tokens. Fewer bits make a smaller number, and there are two ways
    /// for the decoder to stop after the last token.
    pub fn finish(mut self, logits: &[f32]) -> BigUint {
        let Interval { low, range, steps } = &self.interval;
        let past_last_token = bits_to_continue(range, *steps);

        // It runs out of bits: enough of them to reach the last token, too
        // few to go on, and a point inside the text's interval.
        if *steps > 0 {
            for bit_count in bits_to_continue(&self.previous_range, steps - 1)..past_last_token {
                if let Some(value) = first_point(low, range, *steps, bit_count) {
                    return (BigUint::one() << bit_count) | value;
                }
            }
        }

        // Or it goes on and finds the end-of-text token there.
        self.push(logits, self.eos);
        let Interval { low, range, steps } = &self.interval;
        for bit_count in past_last_token.. {
            if let Some(value) = first_point(low, range, *steps, bit_count) {
                return (BigUint::one() << bit_count) | value;
            }
        }
        unreachable!("every interval contains a point once there are enough bits");
    }
}

pub struct Decoder {
    /// The point being decoded is `value / 2^bit_count`.
    value: BigUint,
    bit_count: u64,
    interval: Interval,
    eos: u32,
}

impl Decoder {
    /// `code` is a number as produced by `Encoder::finish` (any number >= 1).
    pub fn new(code: &BigUint, eos: u32) -> Decoder {
        assert!(!code.is_zero());
        let bit_count = code.bits() - 1;
        Decoder {
            value: code - (BigUint::one() << bit_count),
            bit_count,
            interval: Interval::new(),
            eos,
        }
    }

    /// True once the bits of the code are used up: the interval is narrower
    /// than 2^-bit_count, so the code says nothing about further tokens.
    pub fn exhausted(&self) -> bool {
        let denominator_bits = TOTAL_BITS * self.interval.steps;
        denominator_bits >= self.bit_count
            && self.interval.range.bits() <= denominator_bits - self.bit_count
    }

    /// The next token, given the model's predictions for it. The caller stops
    /// at the end-of-text token or when the decoder is exhausted.
    pub fn next(&mut self, logits: &[f32]) -> u32 {
        let (token, (start, freq)) = token_at(logits, self.eos, self.target());
        self.narrow(start, freq);
        token
    }

    /// Where in [0, 2^32) the code points for the next token: the next token
    /// is the one whose slice contains this.
    pub fn target(&self) -> u64 {
        let scaled = (&self.value << (TOTAL_BITS * (self.interval.steps + 1))) >> self.bit_count;
        let offset = (scaled - (&self.interval.low << TOTAL_BITS)) / &self.interval.range;
        offset.iter_u64_digits().next().unwrap_or(0)
    }

    /// Moves past the next token, given its slice.
    pub fn narrow(&mut self, start: u64, freq: u64) {
        self.interval.narrow(start, freq);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VOCAB: usize = 500;
    const EOS: u32 = 499;

    /// A stand-in "language model": deterministic logits from the context.
    fn fake_logits(context: &[u32]) -> Vec<f32> {
        let mut state = 0x9E3779B97F4A7C15u64;
        for &t in context.iter().rev().take(3) {
            state = (state ^ t as u64).wrapping_mul(0xBF58476D1CE4E5B9);
        }
        (0..VOCAB)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state % 2000) as f32 / 100.0
            })
            .collect()
    }

    fn top(logits: &[f32]) -> u32 {
        (0..logits.len()).max_by(|&a, &b| logits[a].partial_cmp(&logits[b]).unwrap()).unwrap() as u32
    }

    fn encode(tokens: &[u32]) -> BigUint {
        let mut encoder = Encoder::new(EOS);
        for i in 0..tokens.len() {
            encoder.push(&fake_logits(&tokens[..i]), tokens[i]);
        }
        encoder.finish(&fake_logits(tokens))
    }

    fn decode(code: &BigUint) -> Vec<u32> {
        let mut decoder = Decoder::new(code, EOS);
        let mut tokens = vec![];
        while !decoder.exhausted() {
            let token = decoder.next(&fake_logits(&tokens));
            if token == EOS {
                break;
            }
            tokens.push(token);
        }
        tokens
    }

    fn random_tokens(length: usize, state: &mut u64) -> Vec<u32> {
        (0..length)
            .map(|_| {
                *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                ((*state >> 33) % (VOCAB as u64 - 1)) as u32
            })
            .collect()
    }

    #[test]
    fn frequencies_sum_to_total() {
        let d = Distribution::new(&fake_logits(&[1, 2, 3]), EOS);
        assert_eq!(d.freqs.iter().map(|&f| f as u64).sum::<u64>(), TOTAL);
        assert!(d.freqs.iter().all(|&f| f >= 1));
        assert_eq!(d.interval(EOS as usize).0, 0);
        for token in [0, 7, VOCAB - 1] {
            let (start, freq) = d.interval(token);
            assert_eq!(d.find(start), token);
            assert_eq!(d.find(start + freq - 1), token);
        }
    }

    #[test]
    fn round_trips_random_text() {
        let mut state = 12345u64;
        for length in [0usize, 1, 2, 3, 10, 300] {
            for _ in 0..20 {
                let tokens = random_tokens(length, &mut state);
                assert_eq!(decode(&encode(&tokens)), tokens, "length {}", length);
            }
        }
    }

    #[test]
    fn round_trips_predictable_text() {
        // Near-certain tokens barely narrow the interval, which is the hard
        // case for knowing where the text stops.
        let mut logits = vec![0.0f32; VOCAB];
        logits[3] = 40.0;
        for length in 0..40 {
            let tokens = vec![3u32; length];
            let mut encoder = Encoder::new(EOS);
            for _ in 0..length {
                encoder.push(&logits, 3);
            }
            let code = encoder.finish(&logits);
            let mut decoder = Decoder::new(&code, EOS);
            let mut decoded = vec![];
            while !decoder.exhausted() {
                let token = decoder.next(&logits);
                if token == EOS {
                    break;
                }
                decoded.push(token);
            }
            assert_eq!(decoded, tokens);
        }
    }

    #[test]
    fn finds_the_first_code_of_a_text() {
        // Likely texts have codes small enough to try every number before them.
        let mut first = vec![];
        first.push(top(&fake_logits(&first)));
        let mut second = first.clone();
        second.push(top(&fake_logits(&second)));
        for tokens in [vec![], first, second] {
            let code = encode(&tokens);
            assert_eq!(decode(&code), tokens);
            let limit = code.iter_u64_digits().next().unwrap_or(0);
            assert!(code.bits() <= 24, "the text should be likely enough to search");
            for smaller in 1..limit {
                assert_ne!(decode(&BigUint::from(smaller)), tokens, "code {} comes before {}", smaller, code);
            }
        }
    }

    #[test]
    fn likely_text_gets_a_small_number() {
        let mut likely = vec![];
        for _ in 0..50 {
            likely.push(top(&fake_logits(&likely)));
        }
        let mut state = 1u64;
        let unlikely = random_tokens(50, &mut state);
        assert!(encode(&likely).bits() * 2 < encode(&unlikely).bits());
    }

    #[test]
    fn every_number_decodes_to_a_short_text() {
        // Code 1 has no bits: it is the empty text.
        assert!(decode(&BigUint::one()).is_empty());
        for n in 1u32..2000 {
            let code = BigUint::from(n);
            // Every token costs at least a little, so texts stay short.
            assert!(decode(&code).len() as u64 <= 2 * code.bits());
        }
    }
}
