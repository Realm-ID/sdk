package dev.realmid.sdk;

/**
 * R86: the typed error for the device-approval BFF's {@code 403 device_approval_not_allowed} (SPEC 3.1, 15):
 * the partner's CanApprove refused this person. Built by the response decoder; test it with
 * {@link RealmException#isDeviceApprovalNotAllowed}.
 */
public final class DeviceApprovalNotAllowedException extends RealmException {

    public DeviceApprovalNotAllowedException(String message, int httpStatus, java.util.Map<String, Object> details) {
        super(ErrorCode.DEVICE_APPROVAL_NOT_ALLOWED, message, httpStatus, details);
    }
}
