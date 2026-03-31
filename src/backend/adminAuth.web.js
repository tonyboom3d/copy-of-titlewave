import { Permissions, webMethod } from 'wix-web-module'
import { currentMember } from 'wix-members-backend'

export const checkMemberRoles = webMethod(Permissions.Anyone, async () => {
    try {
        const roles = await currentMember.getRoles()
        let isAdmin = false
        let isContributor = false
        let isOwner = false

        roles.forEach(role => {
            if (role.title === 'Admin') {
                isAdmin = true
                isOwner = true
            }
            if (role.title === 'Site Contributor') {
                isContributor = true
            }
        })

        return {
            ok: true,
            isAdmin,
            isContributor,
            isOwner,
            roles
        }
    } catch (error) {
        console.error("Error checking member roles:", error)
        return {
            ok: false,
            isAdmin: false,
            isContributor: false,
            isOwner: false,
            roles: []
        }
    }
})