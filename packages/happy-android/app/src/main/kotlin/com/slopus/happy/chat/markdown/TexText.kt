package com.slopus.happy.chat.markdown

/**
 * Simple TeX math as plain Unicode text, for math inside a sentence (`$…$`,
 * `\(…\)`): Greek letters, operators, relations and arrows as their
 * symbols, `^` and `_` as superscript and subscript characters, `\frac` as
 * a slash and `\sqrt` as a radical, font and text commands as their
 * content. [of] is null when any part has no such text (an environment, a
 * line break, an alignment, a character Unicode has no superscript or
 * subscript for, a command not listed here): that math stays as written.
 */
object TexText {
    fun of(tex: String): String? {
        val reader = Reader(tex)
        val text = reader.sequence(inGroup = false) ?: return null
        return text.replace(SPACES, " ").trim().ifEmpty { null }
    }

    private val SPACES = Regex(" {2,}")

    private class Reader(val s: String) {
        var i = 0

        /** Items up to the end, or up to and past the closing brace when [inGroup]. */
        fun sequence(inGroup: Boolean): String? {
            val out = StringBuilder()
            while (i < s.length) {
                val c = s[i]
                when {
                    c == '}' -> {
                        if (!inGroup) return null
                        i++
                        return out.toString()
                    }
                    c == '{' -> {
                        i++
                        out.append(sequence(inGroup = true) ?: return null)
                    }
                    c == '^' || c == '_' -> {
                        i++
                        val argument = atom() ?: return null
                        out.append(script(argument, superscript = c == '^') ?: return null)
                    }
                    c == '\\' -> out.append(command() ?: return null)
                    c == '&' -> return null
                    c == '\'' -> {
                        i++
                        out.append('′')
                    }
                    c == '~' || c.isWhitespace() -> {
                        i++
                        out.append(' ')
                    }
                    else -> {
                        i++
                        out.append(c)
                    }
                }
            }
            return if (inGroup) null else out.toString()
        }

        /** One argument: a group, a command, or one character. */
        fun atom(): String? {
            skipSpaces()
            if (i >= s.length) return null
            return when (s[i]) {
                '{' -> {
                    i++
                    sequence(inGroup = true)
                }
                '\\' -> command()
                '}', '^', '_', '&' -> null
                else -> s[i++].toString()
            }
        }

        fun command(): String? {
            i++
            if (i >= s.length) return null
            val first = s[i]
            if (!first.isLetter()) {
                i++
                return when (first) {
                    ',', ':', ';', '>', ' ' -> " "
                    '!' -> ""
                    '{', '}', '$', '%', '#', '&', '_' -> first.toString()
                    '|' -> "‖"
                    else -> null
                }
            }
            val start = i
            while (i < s.length && s[i].isLetter()) i++
            val name = s.substring(start, i)
            SYMBOLS[name]?.let { return it }
            RELATIONS[name]?.let { return " $it " }
            if (name in FUNCTIONS) return name
            return when (name) {
                "quad" -> "  "
                "qquad" -> "    "
                "left", "right", "middle", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr" -> {
                    // The delimiter after it is read as itself; `.` is none.
                    skipSpaces()
                    if (i < s.length && s[i] == '.') i++
                    ""
                }
                "frac", "dfrac", "tfrac" -> {
                    val numerator = atom() ?: return null
                    val denominator = atom() ?: return null
                    "${operand(numerator)}/${operand(denominator)}"
                }
                "sqrt" -> {
                    skipSpaces()
                    if (i < s.length && s[i] == '[') return null
                    "√" + operand(atom() ?: return null)
                }
                "text", "textrm", "textit", "textbf", "textsf", "texttt", "mbox",
                "mathrm", "mathit", "mathbf", "mathsf", "mathtt", "boldsymbol", "bm", "operatorname" -> {
                    if (i < s.length && s[i] == '*') i++
                    atom()
                }
                "mathbb" -> atom()?.let { DOUBLE_STRUCK[it] }
                "mathcal", "mathscr" -> atom()?.let { SCRIPT[it] }
                "bar", "overline", "hat", "widehat", "tilde", "widetilde", "vec", "dot", "ddot" -> {
                    val argument = atom() ?: return null
                    if (argument.codePointCount(0, argument.length) != 1) return null
                    argument + ACCENTS.getValue(name)
                }
                "bmod", "mod" -> " mod "
                "pmod" -> atom()?.let { " (mod $it)" }
                else -> null
            }
        }

        fun skipSpaces() {
            while (i < s.length && s[i].isWhitespace()) i++
        }
    }

    /** [text] as superscript or subscript characters; null when one has none. */
    private fun script(text: String, superscript: Boolean): String? {
        val table = if (superscript) SUPERSCRIPT else SUBSCRIPT
        val out = StringBuilder()
        for (c in text) {
            if (c == ' ') continue
            out.append(table[c] ?: return null)
        }
        return out.toString().ifEmpty { null }
    }

    /** A fraction's side: itself when it is one word or number, else in parentheses. */
    private fun operand(text: String): String {
        val trimmed = text.trim()
        return if (trimmed.all { it.isLetterOrDigit() || it == '.' || it == '′' }) trimmed else "($trimmed)"
    }

    private val SUPERSCRIPT: Map<Char, String> = (
        "0⁰ 1¹ 2² 3³ 4⁴ 5⁵ 6⁶ 7⁷ 8⁸ 9⁹ +⁺ -⁻ =⁼ (⁽ )⁾ " +
            "aᵃ bᵇ cᶜ dᵈ eᵉ fᶠ gᵍ hʰ iⁱ jʲ kᵏ lˡ mᵐ nⁿ oᵒ pᵖ rʳ sˢ tᵗ uᵘ vᵛ wʷ xˣ yʸ zᶻ " +
            "Aᴬ Bᴮ Dᴰ Eᴱ Gᴳ Hᴴ Iᴵ Jᴶ Kᴷ Lᴸ Mᴹ Nᴺ Oᴼ Pᴾ Rᴿ Tᵀ Uᵁ Vⱽ Wᵂ " +
            "αᵅ βᵝ γᵞ δᵟ εᵋ θᶿ ιᶥ φᵠ χᵡ"
        ).split(' ').associate { it[0] to it.substring(1) } +
        mapOf('′' to "′", '∘' to "°", '*' to "*", '⊤' to "ᵀ", '†' to "†", ',' to ",")

    private val SUBSCRIPT: Map<Char, String> = (
        "0₀ 1₁ 2₂ 3₃ 4₄ 5₅ 6₆ 7₇ 8₈ 9₉ +₊ -₋ =₌ (₍ )₎ " +
            "aₐ eₑ hₕ iᵢ jⱼ kₖ lₗ mₘ nₙ oₒ pₚ rᵣ sₛ tₜ uᵤ vᵥ xₓ " +
            "βᵦ γᵧ ρᵨ φᵩ χᵪ"
        ).split(' ').associate { it[0] to it.substring(1) } + mapOf(',' to ",")

    private val SYMBOLS = mapOf(
        "alpha" to "α", "beta" to "β", "gamma" to "γ", "delta" to "δ", "epsilon" to "ϵ", "varepsilon" to "ε",
        "zeta" to "ζ", "eta" to "η", "theta" to "θ", "vartheta" to "ϑ", "iota" to "ι", "kappa" to "κ",
        "lambda" to "λ", "mu" to "μ", "nu" to "ν", "xi" to "ξ", "pi" to "π", "varpi" to "ϖ", "rho" to "ρ",
        "varrho" to "ϱ", "sigma" to "σ", "varsigma" to "ς", "tau" to "τ", "upsilon" to "υ", "phi" to "ϕ",
        "varphi" to "φ", "chi" to "χ", "psi" to "ψ", "omega" to "ω",
        "Gamma" to "Γ", "Delta" to "Δ", "Theta" to "Θ", "Lambda" to "Λ", "Xi" to "Ξ", "Pi" to "Π",
        "Sigma" to "Σ", "Upsilon" to "Υ", "Phi" to "Φ", "Psi" to "Ψ", "Omega" to "Ω",
        "infty" to "∞", "partial" to "∂", "nabla" to "∇", "sum" to "∑", "prod" to "∏", "coprod" to "∐",
        "int" to "∫", "iint" to "∬", "oint" to "∮", "emptyset" to "∅", "varnothing" to "∅",
        "forall" to "∀", "exists" to "∃", "nexists" to "∄", "neg" to "¬", "lnot" to "¬",
        "angle" to "∠", "top" to "⊤", "bot" to "⊥", "prime" to "′", "ell" to "ℓ", "hbar" to "ℏ",
        "Re" to "ℜ", "Im" to "ℑ", "aleph" to "ℵ", "langle" to "⟨", "rangle" to "⟩", "lfloor" to "⌊",
        "rfloor" to "⌋", "lceil" to "⌈", "rceil" to "⌉", "vert" to "|", "lvert" to "|", "rvert" to "|",
        "Vert" to "‖", "lVert" to "‖", "rVert" to "‖", "ldots" to "…", "cdots" to "⋯", "dots" to "…",
        "vdots" to "⋮", "ddots" to "⋱", "dagger" to "†", "ddagger" to "‡", "triangle" to "△",
        "square" to "□", "checkmark" to "✓", "degree" to "°", "circ" to "∘", "bullet" to "∙",
        "star" to "⋆", "ast" to "∗", "S" to "§", "colon" to ":", "therefore" to "∴", "because" to "∵",
        "lbrace" to "{", "rbrace" to "}", "backslash" to "\\",
    )

    /** Binary operators and relations, set apart by a space each side as TeX spaces them. */
    private val RELATIONS = mapOf(
        "pm" to "±", "mp" to "∓", "times" to "×", "div" to "÷", "cdot" to "·", "oplus" to "⊕",
        "otimes" to "⊗", "odot" to "⊙", "le" to "≤", "leq" to "≤", "ge" to "≥", "geq" to "≥",
        "leqslant" to "⩽", "geqslant" to "⩾", "ne" to "≠", "neq" to "≠", "approx" to "≈", "sim" to "∼",
        "simeq" to "≃", "cong" to "≅", "equiv" to "≡", "propto" to "∝", "ll" to "≪", "gg" to "≫",
        "prec" to "≺", "succ" to "≻", "preceq" to "⪯", "succeq" to "⪰", "in" to "∈", "notin" to "∉",
        "ni" to "∋", "subset" to "⊂", "supset" to "⊃", "subseteq" to "⊆", "supseteq" to "⊇",
        "cup" to "∪", "cap" to "∩", "setminus" to "∖", "land" to "∧", "lor" to "∨", "wedge" to "∧",
        "vee" to "∨", "to" to "→", "rightarrow" to "→", "leftarrow" to "←", "gets" to "←",
        "Rightarrow" to "⇒", "Leftarrow" to "⇐", "leftrightarrow" to "↔", "Leftrightarrow" to "⇔",
        "implies" to "⟹", "iff" to "⟺", "mapsto" to "↦", "uparrow" to "↑", "downarrow" to "↓",
        "longrightarrow" to "⟶", "longleftarrow" to "⟵", "mid" to "|", "parallel" to "∥", "perp" to "⊥",
    )

    private val FUNCTIONS = setOf(
        "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan",
        "log", "ln", "lg", "exp", "max", "min", "sup", "inf", "lim", "liminf", "limsup", "det", "dim",
        "ker", "deg", "gcd", "lcm", "arg", "Pr", "hom",
    )

    /** Only the double-struck letters Unicode has in its letterlike block, which every phone font draws. */
    private val DOUBLE_STRUCK = mapOf("N" to "ℕ", "Z" to "ℤ", "Q" to "ℚ", "R" to "ℝ", "C" to "ℂ", "P" to "ℙ", "H" to "ℍ")

    private val SCRIPT = mapOf(
        "B" to "ℬ", "E" to "ℰ", "F" to "ℱ", "H" to "ℋ", "I" to "ℐ", "L" to "ℒ", "M" to "ℳ", "R" to "ℛ",
        "e" to "ℯ", "g" to "ℊ", "o" to "ℴ", "l" to "ℓ",
    )

    private val ACCENTS = mapOf(
        "bar" to "\u0304", "overline" to "\u0305", "hat" to "\u0302", "widehat" to "\u0302",
        "tilde" to "\u0303", "widetilde" to "\u0303", "vec" to "\u20D7", "dot" to "\u0307", "ddot" to "\u0308",
    )
}
