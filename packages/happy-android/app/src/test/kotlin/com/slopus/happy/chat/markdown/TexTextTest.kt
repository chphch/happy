package com.slopus.happy.chat.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Simple inline TeX as Unicode symbols; anything it can't write stays as written. */
class TexTextTest {
    @Test fun `letters, operators and relations become symbols`() {
        assertEquals("α + β", TexText.of("\\alpha + \\beta"))
        assertEquals("x² + y² ≤ 1", TexText.of("x^2 + y^2 \\le 1"))
        assertEquals("a ≠ b → c", TexText.of("a \\neq b \\to c"))
        assertEquals("∀ x ∈ ℝ", TexText.of("\\forall x \\in \\mathbb{R}"))
        assertEquals("Δ = 0.5", TexText.of("\\Delta = 0.5"))
        assertEquals("O(n log n)", TexText.of("O(n \\log n)"))
        assertEquals("f′(x)", TexText.of("f'(x)"))
        assertEquals("|x|", TexText.of("\\left|x\\right|"))
        assertEquals("ℒ(θ)", TexText.of("\\mathcal{L}(\\theta)"))
        assertEquals("x\u0302", TexText.of("\\hat{x}"))
        assertEquals("p(y | x)", TexText.of("p(y \\mid x)"))
        assertEquals("text in math", TexText.of("\\text{text in math}"))
    }

    @Test fun `scripts, fractions and roots`() {
        assertEquals("xᵢ₊₁", TexText.of("x_{i+1}"))
        assertEquals("A⁻¹", TexText.of("A^{-1}"))
        assertEquals("ℝⁿ", TexText.of("\\mathbb{R}^n"))
        assertEquals("Wᵀ x", TexText.of("W^\\top x"))
        assertEquals("∑ᵢ₌₁ⁿ xᵢ", TexText.of("\\sum_{i=1}^{n} x_i"))
        assertEquals("1/2", TexText.of("\\frac{1}{2}"))
        assertEquals("(a+b)/c", TexText.of("\\frac{a+b}{c}"))
        assertEquals("√2", TexText.of("\\sqrt{2}"))
        assertEquals("√(x+1)", TexText.of("\\sqrt{x+1}"))
        assertEquals("90°", TexText.of("90^\\circ"))
    }

    @Test fun `what has no plain text stays as written`() {
        listOf(
            "\\begin{pmatrix}a\\end{pmatrix}", // an environment
            "a \\\\ b", // a line break
            "a & b", // an alignment
            "x^q", // q has no superscript
            "x_b", // b has no subscript
            "\\sum_{i=1}^{\\infty}", // nor does ∞
            "\\sqrt[3]{x}", // a root's degree
            "\\mathbb{E}[X]", // outside the letterlike block
            "\\unknowncommand",
            "{x", // a group never closed
            "x}", // a brace never opened
            "",
        ).forEach { assertNull(it, TexText.of(it)) }
    }
}
