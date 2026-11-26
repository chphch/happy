package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Home's project chats are carried to another place in their list, as the
 * desktop's tab strip carries its tabs and iOS's sidebar its bots and tasks
 * (8386b4dd5c): a hold opens the chat's preview; the finger moving on lifts
 * the row and puts the preview away, and letting go asks for the move after
 * the chat now before it. A chat's own list is its only place, its subtasks
 * go with it, and a screen reader moves it a place at a time.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeChatDragTest {
    @get:Rule val rule = createComposeRule()

    private fun folder(id: String, depth: Int = 0) = AgentFeedRow.Folder(id, id, depth)

    private fun chat(id: String, owner: String = "p1", depth: Int = 1, parentId: String? = null) = AgentFeedRow.Conversation(
        id, id.uppercase(), if (parentId == null) ConversationKind.Project else ConversationKind.Subtask, depth, workspaceId = owner, parentId = parentId,
    )

    private fun card(vararg rows: AgentFeedRow) = rows.mapIndexed { i, row -> AgentHomeItem.Row(row, first = i == 0, last = i == rows.lastIndex) }

    private fun ids(items: List<AgentHomeItem>) = items.map { it.key.substringAfter('-') }

    @Test fun `a list's chats take the order given with their subtasks, and the card keeps its foot`() {
        val items = card(folder("p1"), chat("a"), chat("a1", depth = 2, parentId = "a"), chat("b"), chat("c"))
        val arranged = arrangedHomeItems(items, "p1", listOf("c", "a", "b"), folded = null)
        assertEquals(listOf("p1", "c", "a", "a1", "b"), ids(arranged))
        assertEquals(listOf(false, false, false, false, true), arranged.map { (it as AgentHomeItem.Row).last })
        // Carried, a chat's subtasks fold away.
        assertEquals(listOf("p1", "b", "a", "c"), ids(arrangedHomeItems(items, "p1", listOf("b", "a", "c"), folded = "a")))
        // Nothing to arrange: the list itself, so no row composes again.
        assertSame(items, arrangedHomeItems(items, "p1", listOf("a", "b", "c"), folded = null))
        assertSame(items, arrangedHomeItems(items, null, null, folded = null))
    }

    @Test fun `a worktree's chats move among themselves only`() {
        val items = card(folder("p1"), chat("a"), chat("b"), folder("w1", depth = 1), chat("w", owner = "w1", depth = 2), chat("x", owner = "w1", depth = 2))
        assertEquals(listOf("p1", "a", "b", "w1", "x", "w"), ids(arrangedHomeItems(items, "w1", listOf("x", "w"), folded = null)))
        val moves = homeRowMoves(items)
        assertEquals(HomeRowMoves(up = false, upAfter = null, down = true, downAfter = "b"), moves["a"])
        assertEquals(HomeRowMoves(up = true, upAfter = null, down = false, downAfter = null), moves["b"])
        assertEquals(HomeRowMoves(up = true, upAfter = null, down = false, downAfter = null), moves["x"])
    }

    @Test fun `a held chat lifts as the finger moves on, puts its preview away and goes after the chat now before it`() {
        val moves = mutableListOf<Pair<String, String?>>()
        val holds = mutableListOf<String>()
        var lifts = 0
        rule.setHappyContent {
            AgentHomeList(
                card(folder("p1"), chat("a"), chat("b"), chat("c")), rememberLazyListState(), onOpen = {}, contentPadding = PaddingValues(),
                onHold = { row, _ -> holds += row.agentId },
                onReorder = { row, afterId -> moves += row.agentId to afterId },
                onLift = { lifts++ },
            )
        }
        val c = rule.node(AgentHomeTags.row("agent-c"))
        c.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(700)
        // The hold opens the preview, and nothing is carried yet.
        rule.runOnIdle {
            assertEquals(listOf("c"), holds)
            assertEquals(0, lifts)
        }
        c.performTouchInput {
            moveBy(Offset(0f, -height * 2.2f))
            up()
        }
        rule.waitUntil(5_000) { moves.isNotEmpty() }
        rule.runOnIdle {
            assertEquals(1, lifts)
            assertEquals(listOf("c" to null), moves)
        }
    }

    @Test fun `a hold that never moves carries nothing`() {
        val moves = mutableListOf<Pair<String, String?>>()
        var lifts = 0
        rule.setHappyContent {
            AgentHomeList(
                card(folder("p1"), chat("a"), chat("b")), rememberLazyListState(), onOpen = {}, contentPadding = PaddingValues(),
                onHold = { _, _ -> }, onReorder = { row, afterId -> moves += row.agentId to afterId }, onLift = { lifts++ },
            )
        }
        val b = rule.node(AgentHomeTags.row("agent-b"))
        b.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(700)
        b.performTouchInput { up() }
        rule.waitForIdle()
        assertEquals(0, lifts)
        assertEquals(emptyList<Pair<String, String?>>(), moves)
    }

    @Test fun `a screen reader moves a chat a place at a time`() {
        val moves = mutableListOf<Pair<String, String?>>()
        rule.setHappyContent {
            AgentHomeList(
                card(folder("p1"), chat("a"), chat("b"), chat("c")), rememberLazyListState(), onOpen = {}, contentPadding = PaddingValues(),
                onReorder = { row, afterId -> moves += row.agentId to afterId },
            )
        }
        val actions = rule.onNodeWithText("B").fetchSemanticsNode().config[SemanticsActions.CustomActions]
        actions.first { it.label == "Move up" }.action()
        actions.first { it.label == "Move down" }.action()
        rule.runOnIdle { assertEquals(listOf("b" to null, "b" to "c"), moves) }
    }
}
