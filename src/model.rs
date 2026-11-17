//! SmolLM2-135M, run one token at a time.
//!
//! Page numbers only decode if every machine computes exactly the same
//! logits, so this is written to be reproducible bit for bit rather than
//! handed to a general runtime:
//!
//! - The big matrix products are integer dot products (8-bit weights from
//!   tools/convert_weights.py times 12-bit activations), which are exact.
//! - Everything else is IEEE float arithmetic in a fixed order, with `libm`
//!   for exp, sin, cos and pow instead of the platform's math library.
//!
//! WebAssembly SIMD is used where available; it gives the same results as the
//! scalar code, lane for lane.

use std::rc::Rc;

pub const VOCAB: usize = 49152;
/// `<|endoftext|>`, which also starts every context.
pub const EOS: u32 = 0;
/// Token ids below this are special tokens and never part of a page's text.
pub const SPECIAL_TOKENS: u32 = 17;

const HIDDEN: usize = 576;
const MLP: usize = 1536;
const LAYERS: usize = 30;
const HEADS: usize = 9;
const KV_HEADS: usize = 3;
const HEAD_DIM: usize = 64;
const KV_DIM: usize = KV_HEADS * HEAD_DIM;
const NORM_EPS: f32 = 1e-5;
const ROPE_THETA: f64 = 100000.0;
const MAGIC: &[u8] = b"INFNB1\0\0";

/// Activations are rounded to integers in [-ACTIVATION_MAX, ACTIVATION_MAX]
/// before a matrix product. With 8-bit weights and at most 1536 columns the
/// sums stay far inside an i32.
const ACTIVATION_MAX: f32 = 2047.0;

/// Integer dot product of activations and one row of weights.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn dot_i32(activations: &[i16], weights: &[i8]) -> i32 {
    use core::arch::wasm32::*;
    assert!(activations.len() == weights.len() && weights.len() % 16 == 0);
    let mut low = i32x4_splat(0);
    let mut high = i32x4_splat(0);
    for (a, w) in activations.chunks_exact(16).zip(weights.chunks_exact(16)) {
        // SAFETY: both chunks are exactly 16 elements long.
        unsafe {
            let a_low = v128_load(a.as_ptr() as *const v128);
            let a_high = v128_load(a.as_ptr().add(8) as *const v128);
            let w_low = i16x8_load_extend_i8x8(w.as_ptr());
            let w_high = i16x8_load_extend_i8x8(w.as_ptr().add(8));
            low = i32x4_add(low, i32x4_dot_i16x8(a_low, w_low));
            high = i32x4_add(high, i32x4_dot_i16x8(a_high, w_high));
        }
    }
    let sum = i32x4_add(low, high);
    i32x4_extract_lane::<0>(sum)
        .wrapping_add(i32x4_extract_lane::<1>(sum))
        .wrapping_add(i32x4_extract_lane::<2>(sum))
        .wrapping_add(i32x4_extract_lane::<3>(sum))
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn dot_i32(activations: &[i16], weights: &[i8]) -> i32 {
    activations.iter().zip(weights).map(|(&a, &w)| a as i32 * w as i32).sum()
}

/// Float dot product, summed in four interleaved lanes so that the SIMD and
/// scalar versions round identically.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn dot_f32(a: &[f32], b: &[f32]) -> f32 {
    use core::arch::wasm32::*;
    debug_assert!(a.len() == b.len() && a.len() % 4 == 0);
    let mut sum = f32x4_splat(0.0);
    for (a, b) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        // SAFETY: both chunks are exactly 4 elements long.
        unsafe {
            let a = v128_load(a.as_ptr() as *const v128);
            let b = v128_load(b.as_ptr() as *const v128);
            sum = f32x4_add(sum, f32x4_mul(a, b));
        }
    }
    (f32x4_extract_lane::<0>(sum) + f32x4_extract_lane::<1>(sum))
        + (f32x4_extract_lane::<2>(sum) + f32x4_extract_lane::<3>(sum))
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn dot_f32(a: &[f32], b: &[f32]) -> f32 {
    let mut sum = [0.0f32; 4];
    for (a, b) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        for lane in 0..4 {
            sum[lane] += a[lane] * b[lane];
        }
    }
    (sum[0] + sum[1]) + (sum[2] + sum[3])
}

/// A weight matrix as 8-bit integers with one scale per row. The integers
/// stay where they are in the model file, which all matrices share.
struct Matrix {
    rows: usize,
    cols: usize,
    scales: Vec<f32>,
    file: Rc<Vec<u8>>,
    offset: usize,
}

impl Matrix {
    fn row(&self, row: usize) -> &[i8] {
        let bytes = &self.file[self.offset + row * self.cols..][..self.cols];
        // SAFETY: u8 and i8 have the same size and alignment.
        unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const i8, bytes.len()) }
    }

    /// `output = self * input`. `quantized` is scratch space.
    fn apply(&self, input: &[f32], quantized: &mut Vec<i16>, output: &mut [f32]) {
        assert!(input.len() == self.cols && output.len() == self.rows);
        let max = input.iter().fold(0.0f32, |max, &x| if x.abs() > max { x.abs() } else { max });
        if !(max > 0.0 && max.is_finite()) {
            output.fill(0.0);
            return;
        }
        let to_integer = ACTIVATION_MAX / max;
        quantized.clear();
        quantized.extend(input.iter().map(|&x| {
            let scaled = x * to_integer;
            (if scaled >= 0.0 { scaled + 0.5 } else { scaled - 0.5 }) as i16
        }));
        let from_integer = max / ACTIVATION_MAX;
        for (row, out) in output.iter_mut().enumerate() {
            *out = dot_i32(quantized, self.row(row)) as f32 * (from_integer * self.scales[row]);
        }
    }
}

struct Layer {
    attention_norm: Vec<f32>,
    query: Matrix,
    key: Matrix,
    value: Matrix,
    output: Matrix,
    mlp_norm: Vec<f32>,
    gate: Matrix,
    up: Matrix,
    down: Matrix,
}

pub struct Model {
    /// Token embeddings, which are also the output projection.
    embedding: Matrix,
    layers: Vec<Layer>,
    final_norm: Vec<f32>,
    /// Rotary position frequencies, one per pair of head dimensions.
    frequencies: Vec<f32>,
}

/// Reads the tensors of a model file one after another.
struct Reader {
    file: Rc<Vec<u8>>,
    offset: usize,
}

impl Reader {
    /// Skips `count` bytes and returns where they start.
    fn take(&mut self, count: usize) -> Result<usize, String> {
        if self.file.len() - self.offset < count {
            return Err("the model file is too short".into());
        }
        self.offset += count;
        Ok(self.offset - count)
    }

    fn vector(&mut self, length: usize) -> Result<Vec<f32>, String> {
        let start = self.take(4 * length)?;
        let bytes = &self.file[start..start + 4 * length];
        Ok(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
    }

    fn matrix(&mut self, rows: usize, cols: usize) -> Result<Matrix, String> {
        let scales = self.vector(rows)?;
        let offset = self.take(rows * cols)?;
        Ok(Matrix { rows, cols, scales, file: Rc::clone(&self.file), offset })
    }
}

impl Model {
    /// Loads a model file written by tools/convert_weights.py.
    pub fn new(file: Vec<u8>) -> Result<Model, String> {
        if !file.starts_with(MAGIC) {
            return Err("this is not a model file".into());
        }
        let mut reader = Reader { file: Rc::new(file), offset: MAGIC.len() };
        let embedding = reader.matrix(VOCAB, HIDDEN)?;
        let mut layers = Vec::with_capacity(LAYERS);
        for _ in 0..LAYERS {
            layers.push(Layer {
                attention_norm: reader.vector(HIDDEN)?,
                query: reader.matrix(HIDDEN, HIDDEN)?,
                key: reader.matrix(KV_DIM, HIDDEN)?,
                value: reader.matrix(KV_DIM, HIDDEN)?,
                output: reader.matrix(HIDDEN, HIDDEN)?,
                mlp_norm: reader.vector(HIDDEN)?,
                gate: reader.matrix(MLP, HIDDEN)?,
                up: reader.matrix(MLP, HIDDEN)?,
                down: reader.matrix(HIDDEN, MLP)?,
            });
        }
        let final_norm = reader.vector(HIDDEN)?;
        if reader.offset != reader.file.len() {
            return Err("the model file is too long".into());
        }
        let frequencies = (0..HEAD_DIM / 2)
            .map(|i| (1.0 / libm::pow(ROPE_THETA, (2 * i) as f64 / HEAD_DIM as f64)) as f32)
            .collect();
        Ok(Model { embedding, layers, final_norm, frequencies })
    }
}

/// `output = input / rms(input) * weight`
fn rms_norm(input: &[f32], weight: &[f32], output: &mut [f32]) {
    let mean_square = input.iter().fold(0.0f32, |sum, &x| sum + x * x) / input.len() as f32;
    let scale = 1.0 / libm::sqrtf(mean_square + NORM_EPS);
    for ((out, &x), &w) in output.iter_mut().zip(input).zip(weight) {
        *out = x * scale * w;
    }
}

/// Rotates each head's (i, i + 32) pairs by the position's angles.
fn rotate(vector: &mut [f32], cos: &[f32], sin: &[f32]) {
    for head in vector.chunks_exact_mut(HEAD_DIM) {
        let (first, second) = head.split_at_mut(HEAD_DIM / 2);
        for i in 0..HEAD_DIM / 2 {
            let (a, b) = (first[i], second[i]);
            first[i] = a * cos[i] - b * sin[i];
            second[i] = b * cos[i] + a * sin[i];
        }
    }
}

/// The text so far, as the model remembers it, and its prediction for the
/// next token.
pub struct Context {
    model: Rc<Model>,
    position: usize,
    /// Per layer, the keys and values of every position so far.
    keys: Vec<Vec<f32>>,
    values: Vec<Vec<f32>>,
    logits: Vec<f32>,
    // Scratch space.
    quantized: Vec<i16>,
    hidden: Vec<f32>,
    normed: Vec<f32>,
    query: Vec<f32>,
    key: Vec<f32>,
    value: Vec<f32>,
    attended: Vec<f32>,
    scores: Vec<f32>,
    update: Vec<f32>,
    gate: Vec<f32>,
    up: Vec<f32>,
}

impl Context {
    pub fn new(model: Rc<Model>) -> Context {
        Context {
            model,
            position: 0,
            keys: vec![Vec::new(); LAYERS],
            values: vec![Vec::new(); LAYERS],
            logits: vec![0.0; VOCAB],
            quantized: Vec::with_capacity(MLP),
            hidden: vec![0.0; HIDDEN],
            normed: vec![0.0; HIDDEN],
            query: vec![0.0; HIDDEN],
            key: vec![0.0; KV_DIM],
            value: vec![0.0; KV_DIM],
            attended: vec![0.0; HIDDEN],
            scores: Vec::new(),
            update: vec![0.0; HIDDEN],
            gate: vec![0.0; MLP],
            up: vec![0.0; MLP],
        }
    }

    /// The logits for the token after the ones fed so far.
    pub fn logits(&self) -> &[f32] {
        &self.logits
    }

    /// Feeds one token.
    pub fn feed(&mut self, token: u32) {
        let model = Rc::clone(&self.model);
        let token = token as usize;
        assert!(token < VOCAB, "token outside the vocabulary");

        let scale = model.embedding.scales[token];
        for (h, &w) in self.hidden.iter_mut().zip(model.embedding.row(token)) {
            *h = w as f32 * scale;
        }

        let mut cos = [0.0f32; HEAD_DIM / 2];
        let mut sin = [0.0f32; HEAD_DIM / 2];
        for (i, &frequency) in model.frequencies.iter().enumerate() {
            let angle = self.position as f32 * frequency;
            cos[i] = libm::cosf(angle);
            sin[i] = libm::sinf(angle);
        }

        for (index, layer) in model.layers.iter().enumerate() {
            self.attend(layer, index, &cos, &sin);
            for (h, &u) in self.hidden.iter_mut().zip(&self.update) {
                *h += u;
            }
            self.think(layer);
            for (h, &u) in self.hidden.iter_mut().zip(&self.update) {
                *h += u;
            }
        }

        rms_norm(&self.hidden, &model.final_norm, &mut self.normed);
        model.embedding.apply(&self.normed, &mut self.quantized, &mut self.logits);
        self.position += 1;
    }

    /// Self-attention over every position so far; the result is in `update`.
    fn attend(&mut self, layer: &Layer, index: usize, cos: &[f32], sin: &[f32]) {
        rms_norm(&self.hidden, &layer.attention_norm, &mut self.normed);
        layer.query.apply(&self.normed, &mut self.quantized, &mut self.query);
        layer.key.apply(&self.normed, &mut self.quantized, &mut self.key);
        layer.value.apply(&self.normed, &mut self.quantized, &mut self.value);
        rotate(&mut self.query, cos, sin);
        rotate(&mut self.key, cos, sin);
        self.keys[index].extend_from_slice(&self.key);
        self.values[index].extend_from_slice(&self.value);

        let keys = &self.keys[index];
        let values = &self.values[index];
        let positions = self.position + 1;
        let scale = 1.0 / libm::sqrtf(HEAD_DIM as f32);
        for head in 0..HEADS {
            // Several query heads share each key/value head.
            let shared = (head / (HEADS / KV_HEADS)) * HEAD_DIM;
            let query = &self.query[head * HEAD_DIM..(head + 1) * HEAD_DIM];

            self.scores.clear();
            let mut max = f32::NEG_INFINITY;
            for position in 0..positions {
                let key = &keys[position * KV_DIM + shared..][..HEAD_DIM];
                let score = dot_f32(query, key) * scale;
                if score > max {
                    max = score;
                }
                self.scores.push(score);
            }
            let mut sum = 0.0f32;
            for score in self.scores.iter_mut() {
                *score = libm::expf(*score - max);
                sum += *score;
            }

            let attended = &mut self.attended[head * HEAD_DIM..(head + 1) * HEAD_DIM];
            attended.fill(0.0);
            for (position, &score) in self.scores.iter().enumerate() {
                let weight = score / sum;
                let value = &values[position * KV_DIM + shared..][..HEAD_DIM];
                for (a, &v) in attended.iter_mut().zip(value) {
                    *a += weight * v;
                }
            }
        }
        layer.output.apply(&self.attended, &mut self.quantized, &mut self.update);
    }

    /// The feed-forward block; the result is in `update`.
    fn think(&mut self, layer: &Layer) {
        rms_norm(&self.hidden, &layer.mlp_norm, &mut self.normed);
        layer.gate.apply(&self.normed, &mut self.quantized, &mut self.gate);
        layer.up.apply(&self.normed, &mut self.quantized, &mut self.up);
        for (g, &u) in self.gate.iter_mut().zip(&self.up) {
            // SiLU(gate) * up
            *g = *g / (1.0 + libm::expf(-*g)) * u;
        }
        layer.down.apply(&self.gate, &mut self.quantized, &mut self.update);
    }
}
