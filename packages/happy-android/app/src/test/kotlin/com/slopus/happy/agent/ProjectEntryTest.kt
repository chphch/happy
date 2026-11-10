package com.slopus.happy.agent

import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** New project's entry, read as desktop reads its Add project for a Happy Agent (happyAgentWorkspaceStore.ts). */
class ProjectEntryTest {
    @Test fun `a path from the root, the home folder, a Windows drive or share is a folder`() {
        assertEquals(ProjectEntry.Folder("/srv/app"), ProjectEntry.parse("  /srv/app "))
        assertEquals(ProjectEntry.Folder("~"), ProjectEntry.parse("~"))
        assertEquals(ProjectEntry.Folder("~/Projects/app"), ProjectEntry.parse("~/Projects/app"))
        assertEquals(ProjectEntry.Folder("""~\code"""), ProjectEntry.parse("""~\code"""))
        assertEquals(ProjectEntry.Folder("""C:\work\app"""), ProjectEntry.parse("""C:\work\app"""))
        assertEquals(ProjectEntry.Folder("""\\server\share"""), ProjectEntry.parse("""\\server\share"""))
    }

    @Test fun `a GitHub repository is owner and name, from a URL too, with or without git`() {
        assertEquals(ProjectEntry.Repository("slopus/happy", "happy"), ProjectEntry.parse("slopus/happy"))
        assertEquals(ProjectEntry.Repository("slopus/happy", "happy"), ProjectEntry.parse("https://github.com/slopus/happy.git"))
        assertEquals(ProjectEntry.Repository("slopus/happy", "happy"), ProjectEntry.parse("github.com/slopus/happy/"))
        assertEquals(ProjectEntry.Repository("slopus/happy-agent", "happy-agent"), ProjectEntry.parse("git@github.com:slopus/happy-agent.git"))
        assertEquals(ProjectEntry.Repository("Owner/App", "App"), ProjectEntry.parse("HTTPS://GITHUB.COM/Owner/App"))
    }

    @Test fun `words that are neither, a deeper path or another host read as nothing`() {
        assertNull(ProjectEntry.parse(""))
        assertNull(ProjectEntry.parse("happy"))
        assertNull(ProjectEntry.parse("a/b/c"))
        assertNull(ProjectEntry.parse("https://gitlab.com/owner/app"))
    }

    @Test fun `home spells out a leading tilde without doubling the separator, and is needed for one`() {
        assertEquals("/Users/me/Projects/app", ProjectEntry.Folder("~/Projects/app").absolute("/Users/me/"))
        assertEquals("/Users/me", ProjectEntry.Folder("~").absolute("/Users/me"))
        assertEquals("/srv/app", ProjectEntry.Folder("/srv/app").absolute(null))
        assertNull(ProjectEntry.Folder("~/Projects/app").absolute(null))
        assertNull(ProjectEntry.Folder("~/Projects/app").absolute(""))
    }

    @Test fun `a folder registers by its absolute path, a repository clones under its name`() {
        val (folderPath, folder) = ProjectEntry.request(ProjectEntry.Folder("~/app"), "/home/me", "p1", "m1")!!
        assertEquals("/v0/projects", folderPath)
        assertEquals("/home/me/app", folder["path"]!!.jsonPrimitive.content)
        assertEquals("p1", folder["projectId"]!!.jsonPrimitive.content)
        assertEquals("m1", folder["mutationId"]!!.jsonPrimitive.content)
        val (clonePath, clone) = ProjectEntry.request(ProjectEntry.Repository("slopus/happy", "happy"), null, "p2", "m2")!!
        assertEquals("/v0/projects/clone", clonePath)
        assertEquals("""{"name":"happy","source":{"kind":"github","repository":"slopus/happy"},"projectId":"p2","mutationId":"m2"}""", clone.toString())
        assertNull(ProjectEntry.request(ProjectEntry.Folder("~/app"), null, "p3", "m3"))
    }
}
