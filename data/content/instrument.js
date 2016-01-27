(function () {
    "use strict";

    var global = window.UICGLOBAL,
        reportBlockedFeatures,
        reportFoundUrls,
        isForIFrame = !!self.options.isForIFrame;

    global.script.secPerPage = self.options.secPerPage;

    reportBlockedFeatures = function (features) {
        self.port.emit("content-request-record-blocked-features", {
            features: features,
            url: unsafeWindow.location.toString.call(unsafeWindow.location)
        });
    };
    global.script.reportBlockedFeatures = exportFunction(reportBlockedFeatures, unsafeWindow, {
        allowCrossOriginArguments: true
    });

    /**
     * Reports a list of urls (relative or absolute) that are referenced
     * from the current page to the extension
     *
     * @param array activatedUrls
     *   An array of zero or more strings representing URLs that have been
     *   clicked on or requested by the page.  The elements of the array
     *   are sorted by number of times the page tried to request them
     *   (from most to least)
     * @param array allUrls
     *   An array of zero or more urls (as strings) describing pages referenced
     *   from the current page.
     */
    reportFoundUrls = function (activatedUrls, allUrls) {

        // First make sure all the URLs are unique before we report them
        // to the extension, and that we don't include URLs in the
        // "non-activated" array that were already included in the
        // `activatedUrls` array.
        var nonActivatedUrls = allUrls.reduce(function (prev, cur) {
            if (activatedUrls.indexOf(cur) !== -1) {
                return prev;
            }
            prev[cur] = true;
            return prev;
        }, Object.create(null));

        nonActivatedUrls = Object.keys(nonActivatedUrls);
        global.debug("Found " + nonActivatedUrls.length + " urls referenced in a elements on this page");
        self.port.emit("content-request-found-urls", [activatedUrls, nonActivatedUrls]);
    };
    global.script.reportFoundUrls = exportFunction(reportFoundUrls, unsafeWindow, {
        allowCrossOriginArguments: true
    });


    unsafeWindow.eval(self.options.gremlinSource);
    unsafeWindow.eval(`(function () {

        var featureRefFromPath,
            recordBlockedFeature,
            recordedFeatures = {},
            instrumentMethod,
            instrumentPropertySet,
            featureTypeToFuncMap,
            origQuerySelectorAll = window.document.querySelectorAll,
            origSetTimeout = window.setTimeout,
            origAddEventListener = window.Node.prototype.addEventListener,
            origUrlToString = window.URL.prototype.toString,
            currentLocationString = window.location.toString(),
            isUrlOnCurrentPage,
            requestedUrls,
            parseStringToUrl,
            sharedAnchorEventListiner,
            onLocationChange,
            documentObserver;


        parseStringToUrl = function (aUrlString) {
            return new window.URL(aUrlString, currentLocationString);
        };


        isUrlOnCurrentPage = (function () {
            var curPageUrl = parseStringToUrl(currentLocationString);
            return function (aUrlString) {
                var newUrl = parseStringToUrl(aUrlString),
                    urlsAreSimilar = (newUrl.host === curPageUrl.host &&
                        newUrl.pathname === curPageUrl.pathname &&
                        newUrl.search === curPageUrl.search);
                return urlsAreSimilar;
            };
        }());


        requestedUrls = (function () {

            var urls = {};

            return {
                add: function (aUrl) {
                    var newUrl = parseStringToUrl(aUrl);
                    if (urls[newUrl] === undefined) {
                        urls[newUrl] = 1;
                    } else {
                        urls[newUrl] += 1;
                    }
                    return this;
                },
                all: function () {
                    var flattenedUrls = Object.keys(urls).map(aUrl => [aUrl, urls[aUrl]]);
                    flattenedUrls.sort((a, b) => a[1] - b[1]);
                    flattenedUrls.reverse();
                    return flattenedUrls.map(entry => entry[0]);
                }
            };
        }());


        // We want to be able to trap location changes.  We catch
        // two ways that this can be done right now.  Clicking on
        // anchors and changing window.location.  We prevent the
        // anchor clicking case by installing a click handler on
        // all anchors that can prevent the click event.
        // We handle the {window|document}.location cases using
        // Object.watch
        sharedAnchorEventListiner = function (event) {
            var newUrl = event.currentTarget.href.trim();
            // If we have some anchor value that is often used for
            // indicating we shouldn't change pages, then we don't
            // need to intecept the call or anything similar
            if (!isUrlOnCurrentPage(newUrl)) {
                UICGLOBAL.debug("Detected click on anchor with href: " + newUrl);
                requestedUrls.add(newUrl);
                event.currentTarget.href = "";
                event.preventDefault();
            }
        };
        documentObserver = new MutationObserver(function (mutations) {
            mutations.forEach(function (aMutation) {
                Array.prototype.forEach.call(aMutation.addedNodes, function (aNewNode) {
                    if (aNewNode.nodeName !== "a") {
                        return;
                    }
                    origAddEventListener.call(aNewNode, "click", sharedAnchorEventListiner, false);
                });
            });
        });
        documentObserver.observe(window.document, {childList: true, subtree: true});


        onLocationChange = function (id, oldVal, newVal) {
            if (isUrlOnCurrentPage(newVal)) {
                return newVal;
            }
            UICGLOBAL.debug("Detected location change to: " + newVal);
            requestedUrls.add(newVal);
            return newVal;
        };
        document.watch("location", function () {
            recordBlockedFeature(["document", "location"]);
            onLocationChange.apply(this, arguments);
        });
        window.watch("location", function () {
            recordBlockedFeature(["window", "location"]);
            onLocationChange.apply(this, arguments);
        });
        document.location.watch("href", function () {
            recordBlockedFeature(["document", "location", "href"]);
            onLocationChange.apply(this, arguments);
        });
        window.location.watch("href", function () {
            recordBlockedFeature(["window", "location", "href"]);
            onLocationChange.apply(this, arguments);
        });


        recordBlockedFeature = function (featureName) {
            featureName = Array.isArray(featureName) ? featureName.join(".") : featureName;
            if (recordedFeatures[featureName] === undefined) {
                recordedFeatures[featureName] = 1;
            } else {
                recordedFeatures[featureName] += 1;
            }
        };


        /**
        * Takes a global DOM object and a path to look up on that object, and returns
        * either information about where to access that object in the DOM, or
        * null if it couldn't be found.
        *
        * @param array path
        *   An array of strings, representing a key path to look up in the DOM
        *   to find a feature's implementation.
        *
        * @return array|null
        *   If we're able to find the feature reference, an array of length three
        *   is returned: [featureRef, featureLeafName, parentRef].  Otherwise, null
        *   is returned.
        */
        featureRefFromPath = function (path) {

            var currentLeaf = window,
                items;

            items = path.map(function (pathPart) {

                var prevLeaf = currentLeaf;

                if (currentLeaf === null || currentLeaf[pathPart] === undefined) {
                    return null;
                }

                currentLeaf = prevLeaf[pathPart];
                return [currentLeaf, pathPart, prevLeaf];
            });

            return items[items.length - 1];
        };


        /**
         * Instruments a property defined in the DOM so that setting a value to
         * the property can be intercepted and prevented if the user desires.
         *
         * @param array propertyPath
         *   An array describing the key path of the feature to be watched and
         *   blocked.
         *
         * @return boolean
         *   True if the given property was instrumented, and false if
         *   there was any error.
         */
        instrumentPropertySet = function (propertyPath) {

            var propertyLookupResult = featureRefFromPath(propertyPath),
                propertyName = propertyPath.join("."),
                propertyRef,
                propertyLeafName,
                propertyParentRef;

            if (["document.location", "window.location"].indexOf(propertyName) !== -1) {
                return;
            }

            // UICGLOBAL.debug(propertyName + ": Debugging property setting feature");

            if (propertyLookupResult === null) {
                UICGLOBAL.debug("Unable to find feature for property rule: " + featureName);
                return false;
            }

            [propertyRef, propertyLeafName, propertyParentRef] = propertyLookupResult;
            propertyParentRef.watch(propertyLeafName, function (id, oldval, newval) {
                recordBlockedFeature(propertyPath);
                return newval;
            });

            return true;
        };


        /**
        * Instruments a method defined in the DOM so that it will only fire if
        * a given function returns true, and otherwise an inert, hardcoded value
        * will be returned.
        *
        * @param array methodPath
        *   A key path pointing to the feature in the DOM that should be
        *   instrumented.
        *
        * @return boolean
        *   True if the given method feature was instrumented, and false if
        *   there was any error.
        */
        instrumentMethod = function (methodPath) {

            var methodLookupResult = featureRefFromPath(methodPath),
                methodName = methodPath.join("."),
                featureRef,
                featureLeafName,
                parentRef;

            if (methodLookupResult === null) {
                // UICGLOBAL.debug("Unable to find feature for method rule: " + methodName);
                return false;
            }

            [featureRef, featureLeafName, parentRef] = methodLookupResult;
            parentRef[featureLeafName] = function () {
                recordBlockedFeature(methodPath);
                return featureRef.apply(this, arguments);
            };

            return true;
        };

        featureTypeToFuncMap = {
            "method": instrumentMethod,
            "promise": instrumentMethod,
            "property": instrumentPropertySet
        };

        Object.keys(UICGLOBAL.features).forEach(function (featureType) {
            UICGLOBAL.features[featureType].forEach(function (featurePath) {
                featureTypeToFuncMap[featureType](featurePath);
            });
        });

        // If we're a top level document (ie not an iframe), then
        // we want to register to let the extension know when we're
        // fully loaded so that we can open some of them programatically.
        if (${isForIFrame}) {
            UICGLOBAL.debug("Instrumenting for iFrame: " + window.location.toString());
            return;
        }
        UICGLOBAL.debug("Instrumenting for top page: " + window.location.toString());

        origAddEventListener.call(document, "DOMContentLoaded", function (event) {
            console.log("I think we're not an iframe: " + currentLocationString);
            Array.prototype.forEach.call(origQuerySelectorAll.call(document, "a"), function (anAnchor) {
                origAddEventListener.call(anAnchor, "click", sharedAnchorEventListiner, false);
                sharedAnchorEventListiner.onclick = sharedAnchorEventListiner;
            });
            origSetTimeout.call(window, function () {
                var anchorTags = origQuerySelectorAll.call(document, "a[href]"),
                    hrefs = Array.prototype.map.call(anchorTags, a => a.href);
                UICGLOBAL.reportBlockedFeatures(recordedFeatures);
                UICGLOBAL.reportFoundUrls(requestedUrls.all(), hrefs);
            }, UICGLOBAL.secPerPage * 1000);
            gremlins.createHorde()
                .allGremlins()
                .gremlin(function() {
                    window.$ = function() {};
                })
                .unleash();
          }, false);
    }())`);
}());
