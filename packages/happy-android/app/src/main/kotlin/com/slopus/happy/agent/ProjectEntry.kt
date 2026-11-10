package com.slopus.happy.agent

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * What New project was given, read as desktop reads its Add project for a
 * Happy Agent (happy-desktop happyAgentWorkspaceStore.ts,
 * `projectFolderParse`, `projectFolderAbsolute`, `githubRepositoryParse`):
 * a folder that already exists where the agent runs, registered as it is,
 * or a GitHub repository the agent clones. A folder is never written the
 * way a repository is, so one entry never reads as both.
 */
sealed interface ProjectEntry {
    /** A folder by its path: from the root (`/srv/app`), from the home folder (`~/Projects/app`), or on a Windows drive or share. */
    data class Folder(val path: String) : ProjectEntry {
        /**
         * [path] as the agent registers it, which is absolute: a leading `~`
         * is the agent's home folder, its home project's path ([home]),
         * trailing separators dropped; null while that isn't known.
         */
        fun absolute(home: String?): String? {
            if (!path.startsWith("~")) return path
            if (home.isNullOrEmpty()) return null
            return home.trimEnd('/', '\\') + path.substring(1)
        }
    }

    /** A GitHub repository ([repository] is `owner/name`), cloned into a folder called [name]. */
    data class Repository(val repository: String, val name: String) : ProjectEntry

    companion object {
        private val FOLDER = Regex("""^(?:/|~(?:$|[/\\])|[A-Za-z]:[/\\]|\\\\)""")
        private val GITHUB = Regex("""^(?:(?:https?://)?github\.com/|git@github\.com:)?([^/\s]+)/([^/?#\s]+?)(?:\.git)?/?$""", RegexOption.IGNORE_CASE)

        /** [text], trimmed, as a folder, else as a GitHub repository; null for neither. */
        fun parse(text: String): ProjectEntry? {
            val value = text.trim()
            if (FOLDER.containsMatchIn(value)) return Folder(value)
            val match = GITHUB.find(value) ?: return null
            val (owner, name) = match.destructured
            if (owner.isEmpty() || name.isEmpty()) return null
            return Repository("$owner/$name", name)
        }

        /**
         * The request that adds [entry], with the client's [projectId] and
         * [mutationId]: `POST /v0/projects` `{path, projectId, mutationId}`
         * for a folder, its `~` spelled out from [home]; `POST
         * /v0/projects/clone` `{name, source: {kind: "github", repository},
         * projectId, mutationId}` for a repository (API.md, "Projects"). Null
         * for a `~` folder while [home] isn't known.
         */
        fun request(entry: ProjectEntry, home: String?, projectId: String, mutationId: String): Pair<String, JsonObject>? = when (entry) {
            is Folder -> entry.absolute(home)?.let { path ->
                "/v0/projects" to buildJsonObject {
                    put("path", path)
                    put("projectId", projectId)
                    put("mutationId", mutationId)
                }
            }
            is Repository -> "/v0/projects/clone" to buildJsonObject {
                put("name", entry.name)
                putJsonObject("source") {
                    put("kind", "github")
                    put("repository", entry.repository)
                }
                put("projectId", projectId)
                put("mutationId", mutationId)
            }
        }
    }
}

/** Why New project added nothing; [AgentSession.addProject] answers null once the agent has it. */
sealed interface ProjectAddFailure {
    /** Neither a folder nor a GitHub repository. */
    data object Unreadable : ProjectAddFailure

    /** A folder under `~` while the agent's home folder isn't known: its full path is needed. */
    data object HomeUnknown : ProjectAddFailure

    /** The agent refused it: its own [reason] (a missing folder, a clone it can't make), blank where it gave none. */
    data class Refused(val reason: String) : ProjectAddFailure

    /** The request didn't reach the agent, or its answer didn't come back. */
    data object Unreachable : ProjectAddFailure
}
